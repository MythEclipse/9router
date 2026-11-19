import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

/**
 * Verify the Next server build is internally consistent before it ships.
 *
 * Two failure classes this catches, both observed in production:
 *
 *   1. A chunk that is invalid JavaScript. Turbopack 16.4.x minified a
 *      template literal ending in `\n` into a double-quoted string whose
 *      escape became a REAL newline, so `require()` of the chunk threw
 *      SyntaxError at runtime and every route that needed the chunk answered
 *      500 with ChunkLoadError. /api/health kept answering 200, so the
 *      deploy looked green.
 *
 *   2. A chunk the route manifests reference but that does not exist on
 *      disk. `next build` over an existing .next can leave a stale chunk
 *      registry next to fresh chunks (or vice versa); the runtime then fails
 *      the same way, on the same subset of routes.
 *
 * Runs after `next build` (postbuild), so both local builds and CI fail
 * before a corrupt tree is deployed.
 */
export function verifyServerChunks({
	projectRoot = process.cwd(),
	distDir = process.env.NEXT_DIST_DIR || ".next",
} = {}) {
	const buildDir = resolve(projectRoot, distDir)
	const serverDir = join(buildDir, "server")

	if (!existsSync(serverDir)) {
		console.log(`[verify-server-chunks] No server build at ${serverDir}; nothing to verify`)
		return { checked: 0, errors: [] }
	}

	const jsFiles = []
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name)
			if (entry.isDirectory()) walk(full)
			else if (entry.name.endsWith(".js")) jsFiles.push(full)
		}
	}
	walk(serverDir)

	const errors = []
	const references = new Set()

	// Pass 1: every server JS file must parse. TypeScript's parser is the
	// cheapest in-process syntax check we already ship as a devDependency.
	// Only the first diagnostic per file is reported: one bad token cascades
	// into hundreds of follow-on errors on the same file.
	for (const file of jsFiles) {
		const text = readFileSync(file, "utf8")
		const sourceFile = ts.createSourceFile(
			file,
			text,
			ts.ScriptTarget.Latest,
			false,
			ts.ScriptKind.JS,
		)
		const first = sourceFile.parseDiagnostics[0]
		if (first) {
			const { line, character } = sourceFile.getLineAndCharacterOfPosition(first.start ?? 0)
			errors.push(
				`${relative(projectRoot, file)}:${line + 1}:${character + 1} — ${ts.flattenDiagnosticMessageText(first.messageText, " ")}`,
			)
		}

		// Collect every chunk path the runtime can `require()` so pass 2 can
		// prove each one resolves to a real file.
		for (const match of text.matchAll(/["'`](server\/chunks\/[^"'`]+\.js)["'`]/g)) {
			references.add(match[1])
		}
	}

	// Pass 2: every referenced chunk must exist on disk.
	for (const ref of references) {
		if (!existsSync(resolve(buildDir, ref))) {
			errors.push(`referenced chunk missing from ${distDir}: ${ref}`)
		}
	}

	if (errors.length > 0) {
		console.error(`[verify-server-chunks] FAILED: ${errors.length} problem(s) in ${buildDir}`)
		for (const error of errors.slice(0, 30)) console.error("  - " + error)
		if (errors.length > 30) console.error(`  … and ${errors.length - 30} more`)
	} else {
		console.log(
			`[verify-server-chunks] OK: ${jsFiles.length} server files parse, ${references.size} chunk references resolve`,
		)
	}
	return { checked: jsFiles.length, errors }
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) ===
		resolve(dirname(fileURLToPath(import.meta.url)), "verify-server-chunks.mjs")
) {
	const { errors } = verifyServerChunks()
	process.exit(errors.length > 0 ? 1 : 0)
}
