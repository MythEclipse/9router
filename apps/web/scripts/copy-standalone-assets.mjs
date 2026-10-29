import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

export async function copyStandaloneAssets({
	projectRoot = process.cwd(),
	distDir = process.env.NEXT_DIST_DIR || ".next",
} = {}) {
	if (process.env.NEXT_TRACING_ROOT_MODE === "workspace") {
		console.log(
			"[standalone-assets] Skipping workspace-traced CLI build; CLI packaging handles assets",
		)
		return
	}

	const buildDir = resolve(projectRoot, distDir)
	const standaloneRoot = resolve(buildDir, "standalone")

	if (!existsSync(standaloneRoot)) {
		console.log(`[standalone-assets] No standalone build found at ${standaloneRoot}`)
		return
	}

	// `outputFileTracingRoot` is the workspace root, so `next build` mirrors the
	// repository layout inside `standalone/`: the app lands in
	// `standalone/apps/web`, not in `standalone/` itself. Staging into
	// `standalone/` would put src/ and scripts/ beside that directory, where the
	// running server — whose __dirname is `standalone/apps/web` — never looks.
	// Resolve the directory that actually holds server.js and stage there.
	const standaloneDir = findAppDir(standaloneRoot)
	if (!standaloneDir) {
		console.log(`[standalone-assets] No server.js under ${standaloneRoot}; nothing to stage`)
		return
	}

	const staticSource = resolve(buildDir, "static")
	const staticDestination = resolve(standaloneDir, distDir, "static")
	if (existsSync(staticSource)) {
		cpSync(staticSource, staticDestination, { recursive: true, force: true })
		console.log(`[standalone-assets] Copied static assets to ${staticDestination}`)
	}

	const publicSource = resolve(projectRoot, "public")
	const publicDestination = resolve(standaloneDir, "public")
	if (existsSync(publicSource)) {
		cpSync(publicSource, publicDestination, { recursive: true, force: true })
		console.log(`[standalone-assets] Copied public assets to ${publicDestination}`)
	}

	// Without it beside server.js the standalone build serves requests unsanitized.
	const serverWrapperTsSource = resolve(projectRoot, "custom-server.ts")
	const serverWrapperSource = resolve(projectRoot, "custom-server.js")
	const serverWrapperDestination = resolve(standaloneDir, "custom-server.js")
	if (existsSync(serverWrapperTsSource)) {
		const result = ts.transpileModule(readFileSync(serverWrapperTsSource, "utf8"), {
			compilerOptions: {
				module: ts.ModuleKind.ESNext,
				target: ts.ScriptTarget.ES2022,
			},
			reportDiagnostics: true,
		})
		const errors =
			result.diagnostics?.filter(
				(diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
			) || []
		if (errors.length) {
			const message = errors
				.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
				.join("\n")
			throw new Error(`Could not compile custom-server.ts:\n${message}`)
		}
		writeFileSync(serverWrapperSource, result.outputText)
	}
	if (existsSync(serverWrapperSource)) {
		cpSync(serverWrapperSource, serverWrapperDestination, { force: true })
		console.log(`[standalone-assets] Copied custom-server.js to ${serverWrapperDestination}`)
	}

	// custom-server.js imports server modules by absolute path under its own
	// __dirname (dashboardGuard + auth-guard-hooks, securityLogRepo,
	// dashboardSession, telegramBackup, backgroundTokenRefresh). `next build`
	// only traces the subset of src/ that reached the webpack graph, so those
	// files are absent from standalone/ and getGuardModule() finds nothing,
	// answering 503 "guard unavailable" instead of serving. assemble.sh stages
	// the same tree for the systemd unit; this makes the plain
	// `npm run build && npm start` (and `bun run build:bun && bun run start:bun`)
	// path work without running assemble.sh first.
	for (const dir of ["src", "scripts", "open-sse"]) {
		const dirSource = resolve(projectRoot, dir)
		const dirDestination = resolve(standaloneDir, dir)
		if (!existsSync(dirSource)) continue
		rmSync(dirDestination, { recursive: true, force: true })
		cpSync(dirSource, dirDestination, { recursive: true, force: true })
		console.log(`[standalone-assets] Copied ${dir}/ to ${dirDestination}`)
	}

	// `src/` is copied as source, so the MITM server is `server.ts` here while
	// `resolveBundledServerPath` looks for a `.js`. The child is spawned as
	// `process.execPath` + path, and that binary (node, at the supported versions)
	// cannot execute a `.ts` file: enabling MITM would fail at spawn with an ENOENT
	// that names no cause. The CLI packaging step does the same bundling, so both
	// distributions run the same JavaScript.
	await stageMitmServer(resolve(standaloneDir, "src", "mitm"), projectRoot)

	// The oRPC use-cases run inside this server too, and they open the database
	// and run the migrator on first use. The migrator walks up from its own
	// location looking for a `migrations/` directory holding SQL; `next build`
	// never traces that directory because it is read at runtime, so without this
	// copy every route that touches the database fails with "Migration journal
	// not found" and answers 500.
	const apiMigrationsSource = resolve(projectRoot, "..", "api", "migrations")
	if (existsSync(apiMigrationsSource)) {
		const apiMigrationsDestination = resolve(standaloneDir, "migrations")
		rmSync(apiMigrationsDestination, { recursive: true, force: true })
		cpSync(apiMigrationsSource, apiMigrationsDestination, { recursive: true, force: true })
		console.log(`[standalone-assets] Copied migrations/ to ${apiMigrationsDestination}`)
	}

	// dashboardGuard.js is copied as source and its `open-sse/*` specifiers are
	// not understood by Node's resolver (they are aliases from jsconfig.json).
	// Keep the source tree beside src/ so those runtime imports resolve in the
	// standalone server, just as they do from the project root.
	const openSseSource = resolve(projectRoot, "open-sse")
	const openSseDestination = resolve(standaloneDir, "open-sse")
	if (existsSync(openSseSource)) {
		rmSync(openSseDestination, { recursive: true, force: true })
		cpSync(openSseSource, openSseDestination, { recursive: true })
		console.log(`[standalone-assets] Copied open-sse/ to ${openSseDestination}`)
	}

	// The auth guard is one of those absolutely-loaded modules, and it imports
	// `next/server`. Output-file tracing never sees that import - it is not in the
	// webpack graph, it is a runtime import from a file copied after the build - so
	// the standalone tree kept only a partial `next` package and the server
	// answered 503 "guard unavailable" with ENOENT node_modules/next/server.js.
	// assemble.sh has always mirrored the full package for the systemd unit; the
	// npm/bun build path needs the same tree to be servable.
	const nextPackageSource = resolve(projectRoot, "node_modules", "next")
	const nextPackageDestination = resolve(standaloneDir, "node_modules", "next")
	if (existsSync(nextPackageSource)) {
		rmSync(nextPackageDestination, { recursive: true, force: true })
		cpSync(nextPackageSource, nextPackageDestination, { recursive: true, force: true })
		console.log(`[standalone-assets] Mirrored the next package to ${nextPackageDestination}`)
	}

	// `sharp` is a runtime dependency for the image-text extractor and native
	// image metadata helpers. The standalone server does not keep the full app's
	// node_modules tree by default, so the generated server chunk can fail with a
	// missing external module like `sharp-<hash>`. Mirror the runtime image stack
	// alongside the full Next package so the server can execute without a custom
	// install step.
	for (const runtimeModule of ["sharp", "@img", "detect-libc", "typescript"]) {
		const moduleSource = resolve(projectRoot, "node_modules", runtimeModule)
		const moduleDestination = resolve(standaloneDir, "node_modules", runtimeModule)
		if (existsSync(moduleSource)) {
			rmSync(moduleDestination, { recursive: true, force: true })
			cpSync(moduleSource, moduleDestination, { recursive: true, force: true })
			console.log(`[standalone-assets] Mirrored ${runtimeModule} to ${moduleDestination}`)
		}
	}
}

/**
 * Emit `src/mitm/server.js` beside its TypeScript source, the way CLI packaging
 * does, so the child process can be started with a plain `node <path>`.
 *
 * Bundled, not transpiled per file: `src/mitm/` imports six siblings by relative
 * specifier, so a per-file emit produces a `server.js` whose very first import
 * (`./antigravityIdeVersion.js`) does not exist on disk. esbuild resolves them into
 * one file that imports nothing but `node:*` builtins.
 *
 * A missing entry is not a failure — platforms without the MITM feature never
 * load it, and the esbuild dependency is checked for the same reason.
 */
async function stageMitmServer(mitmDir, projectRoot) {
	const entry = resolve(mitmDir, "server.ts")
	if (!existsSync(entry)) return
	let esbuild
	try {
		esbuild = await import("esbuild")
	} catch {
		console.log("[standalone-assets] esbuild unavailable; MITM server not bundled")
		return
	}
	const destination = resolve(mitmDir, "server.js")
	await esbuild.build({
		entryPoints: [entry],
		bundle: true,
		platform: "node",
		target: "node20",
		format: "esm",
		outfile: destination,
		logLevel: "silent",
	})
	console.log(`[standalone-assets] Bundled MITM server to ${destination}`)
}

/**
 * The directory inside `standalone/` that holds the built app.
 *
 * With a workspace `outputFileTracingRoot` Next mirrors the repo layout, so the
 * app sits at `standalone/apps/web`; without one it sits at `standalone/`.
 * Finding `server.js` covers both without duplicating the config's knowledge of
 * the tracing root.
 */
function findAppDir(standaloneRoot) {
	const candidates = [standaloneRoot, resolve(standaloneRoot, "apps", "web")]
	return candidates.find((dir) => existsSync(resolve(dir, "server.js"))) ?? null
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) ===
		resolve(dirname(fileURLToPath(import.meta.url)), "copy-standalone-assets.mjs")
) {
	await copyStandaloneAssets()
}
