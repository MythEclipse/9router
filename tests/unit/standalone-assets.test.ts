import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { copyStandaloneAssets } from "../../apps/web/scripts/copy-standalone-assets.mjs"

// The script stages beside whichever directory holds `server.js`, because
// `outputFileTracingRoot` is the workspace root and `next build` mirrors that
// layout into standalone/ — the app lands in `standalone/apps/web`, not in
// `standalone/` itself. A fixture without a server.js is therefore a build the
// script correctly declines to touch, which is not what these tests measure.
function createBuildFixture(distDir) {
	const projectRoot = mkdtempSync(join(tmpdir(), "9router-standalone-assets-"))
	const buildRoot = join(projectRoot, distDir)
	const appRoot = join(buildRoot, "standalone", "apps", "web")
	mkdirSync(appRoot, { recursive: true })
	mkdirSync(join(buildRoot, "static", "chunks"), { recursive: true })
	mkdirSync(join(projectRoot, "public"), { recursive: true })
	writeFileSync(join(appRoot, "server.js"), "// standalone server entry")
	writeFileSync(join(buildRoot, "static", "chunks", "app.js"), "static asset")
	writeFileSync(join(projectRoot, "public", "favicon.svg"), "public asset")
	return projectRoot
}

/** Where the script stages: beside the traced app, not beside standalone/. */
function stagedPath(projectRoot, distDir, ...rest) {
	return join(projectRoot, distDir, "standalone", "apps", "web", ...rest)
}

describe("standalone build assets", () => {
	it("copies static and public assets into the default standalone layout", async () => {
		const projectRoot = createBuildFixture(".next")

		await copyStandaloneAssets({ projectRoot, distDir: ".next" })

		expect(
			readFileSync(stagedPath(projectRoot, ".next", ".next", "static", "chunks", "app.js"), "utf8"),
		).toBe("static asset")
		expect(readFileSync(stagedPath(projectRoot, ".next", "public", "favicon.svg"), "utf8")).toBe(
			"public asset",
		)
	})

	it("uses a custom Next dist directory", async () => {
		const projectRoot = createBuildFixture(".next-cli-build")

		await copyStandaloneAssets({ projectRoot, distDir: ".next-cli-build" })

		expect(
			readFileSync(
				stagedPath(projectRoot, ".next-cli-build", ".next-cli-build", "static", "chunks", "app.js"),
				"utf8",
			),
		).toBe("static asset")
	})

	// Without the wrapper beside server.js nothing can prove a request is local.
	it("copies the request-sanitizing server wrapper into the standalone output", async () => {
		const projectRoot = createBuildFixture(".next")
		writeFileSync(join(projectRoot, "custom-server.ts"), "export const wrapper = true;")

		await copyStandaloneAssets({ projectRoot, distDir: ".next" })

		expect(readFileSync(stagedPath(projectRoot, ".next", "custom-server.js"), "utf8")).toContain(
			"export const wrapper = true;",
		)
		expect(readFileSync(join(projectRoot, "custom-server.js"), "utf8")).toContain(
			"export const wrapper = true;",
		)
	})

	// getGuardModule() resolves the guard by path under the standalone dir; when
	// next build's tracing misses them the standalone server answers 503 "guard
	// unavailable" instead of serving.
	it("stages src/ and scripts/ so the standalone auth guard can load", async () => {
		const projectRoot = createBuildFixture(".next")
		mkdirSync(join(projectRoot, "src", "lib", "db", "repos"), { recursive: true })
		mkdirSync(join(projectRoot, "scripts"), { recursive: true })
		writeFileSync(join(projectRoot, "src", "dashboardGuard.js"), "guard")
		writeFileSync(join(projectRoot, "src", "lib", "db", "repos", "securityLogRepo.js"), "repo")
		writeFileSync(join(projectRoot, "scripts", "auth-guard-hooks.mjs"), "hooks")

		await copyStandaloneAssets({ projectRoot, distDir: ".next" })

		expect(readFileSync(stagedPath(projectRoot, ".next", "src", "dashboardGuard.js"), "utf8")).toBe(
			"guard",
		)
		expect(
			readFileSync(
				stagedPath(projectRoot, ".next", "src", "lib", "db", "repos", "securityLogRepo.js"),
				"utf8",
			),
		).toBe("repo")
		expect(
			readFileSync(stagedPath(projectRoot, ".next", "scripts", "auth-guard-hooks.mjs"), "utf8"),
		).toBe("hooks")
	})

	it("stages open-sse/ so runtime executors can load in standalone", async () => {
		const projectRoot = createBuildFixture(".next")
		mkdirSync(join(projectRoot, "open-sse", "executors"), { recursive: true })
		writeFileSync(
			join(projectRoot, "open-sse", "executors", "opencode.js"),
			"export class OpenCodeExecutor {}",
		)

		await copyStandaloneAssets({ projectRoot, distDir: ".next" })

		expect(
			readFileSync(stagedPath(projectRoot, ".next", "open-sse", "executors", "opencode.js"), "utf8"),
		).toBe("export class OpenCodeExecutor {}")
	})

	// Tracing never sees the guard's runtime `import "next/server"`: the guard is
	// copied in after the build, so it is not in the webpack graph. The standalone
	// tree therefore carried a partial next package and every request answered 503
	// "guard unavailable" with ENOENT node_modules/next/server.js.
	it("mirrors the full next package over the traced partial one", async () => {
		const projectRoot = createBuildFixture(".next")
		mkdirSync(join(projectRoot, "node_modules", "next"), { recursive: true })
		writeFileSync(join(projectRoot, "node_modules", "next", "server.js"), "full server")
		mkdirSync(join(projectRoot, "node_modules", "typescript"), { recursive: true })
		writeFileSync(join(projectRoot, "node_modules", "typescript", "index.js"), "TypeScript compiler")
		mkdirSync(stagedPath(projectRoot, ".next", "node_modules", "next"), { recursive: true })
		writeFileSync(stagedPath(projectRoot, ".next", "node_modules", "next", "package.json"), "partial")

		await copyStandaloneAssets({ projectRoot, distDir: ".next" })

		expect(
			readFileSync(stagedPath(projectRoot, ".next", "node_modules", "next", "server.js"), "utf8"),
		).toBe("full server")
		expect(
			readFileSync(stagedPath(projectRoot, ".next", "node_modules", "typescript", "index.js"), "utf8"),
		).toBe("TypeScript compiler")
		// The mirror replaces the traced directory instead of merging into it.
		expect(() =>
			readFileSync(stagedPath(projectRoot, ".next", "node_modules", "next", "package.json")),
		).toThrow()
	})

	it("mirrors sharp and its native image modules into the standalone bundle", async () => {
		const projectRoot = createBuildFixture(".next")
		mkdirSync(join(projectRoot, "node_modules", "sharp"), { recursive: true })
		writeFileSync(join(projectRoot, "node_modules", "sharp", "package.json"), '{"name":"sharp"}')
		mkdirSync(join(projectRoot, "node_modules", "@img", "sharp-linux-x64"), { recursive: true })
		writeFileSync(
			join(projectRoot, "node_modules", "@img", "sharp-linux-x64", "package.json"),
			'{"name":"@img/sharp-linux-x64"}',
		)
		mkdirSync(join(projectRoot, "node_modules", "detect-libc"), { recursive: true })
		writeFileSync(
			join(projectRoot, "node_modules", "detect-libc", "package.json"),
			'{"name":"detect-libc"}',
		)

		await copyStandaloneAssets({ projectRoot, distDir: ".next" })

		expect(
			readFileSync(stagedPath(projectRoot, ".next", "node_modules", "sharp", "package.json"), "utf8"),
		).toContain('"name":"sharp"')
		expect(
			readFileSync(
				stagedPath(projectRoot, ".next", "node_modules", "@img", "sharp-linux-x64", "package.json"),
				"utf8",
			),
		).toContain('"name":"@img/sharp-linux-x64"')
		expect(
			readFileSync(
				stagedPath(projectRoot, ".next", "node_modules", "detect-libc", "package.json"),
				"utf8",
			),
		).toContain('"name":"detect-libc"')
	})

	it("does not modify workspace-traced CLI builds", async () => {
		const projectRoot = createBuildFixture(".next-cli-build")
		const previousMode = process.env.NEXT_TRACING_ROOT_MODE
		process.env.NEXT_TRACING_ROOT_MODE = "workspace"

		try {
			await copyStandaloneAssets({ projectRoot, distDir: ".next-cli-build" })
		} finally {
			if (previousMode === undefined) delete process.env.NEXT_TRACING_ROOT_MODE
			else process.env.NEXT_TRACING_ROOT_MODE = previousMode
		}

		expect(() =>
			readFileSync(
				stagedPath(projectRoot, ".next-cli-build", ".next-cli-build", "static", "chunks", "app.js"),
			),
		).toThrow()
	})

	// src/ is staged as source, so the MITM server is `server.ts` there while the
	// manager looks for a `.js` and spawns it as `node <path>`. Node cannot execute
	// TypeScript, so enabling MITM on a build with no bundle fails at spawn with an
	// ENOENT that names no cause.
	it("bundles the MITM server so the child can be started with node", async () => {
		const projectRoot = createBuildFixture(".next")
		const mitmSource = join(projectRoot, "src", "mitm")
		mkdirSync(mitmSource, { recursive: true })
		writeFileSync(
			join(mitmSource, "server.ts"),
			[
				'import { helper } from "./helper.ts"',
				"export function start() {",
				"	return helper()",
				"}",
			].join("\n"),
		)
		writeFileSync(join(mitmSource, "helper.ts"), 'export function helper() {\n	return "ok"\n}\n')

		await copyStandaloneAssets({ projectRoot, distDir: ".next" })

		const bundled = readFileSync(stagedPath(projectRoot, ".next", "src", "mitm", "server.js"), "utf8")
		// No relative specifier may survive: the sibling exists only as `.ts`.
		expect(bundled).not.toContain("./helper")
		expect(bundled).toContain("function helper")
	})

	it("leaves a tree with no MITM source untouched", async () => {
		const projectRoot = createBuildFixture(".next")

		await copyStandaloneAssets({ projectRoot, distDir: ".next" })

		expect(() => readFileSync(stagedPath(projectRoot, ".next", "src", "mitm", "server.js"))).toThrow()
	})
})
