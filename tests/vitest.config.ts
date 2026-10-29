import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { Plugin } from "vite"
import { defineConfig } from "vitest/config"

const __dirname = fileURLToPath(new URL(".", import.meta.url))

/**
 * Resolve `bun:sqlite` to an inert stand-in.
 *
 * Vite's `resolve.alias` table never sees a `bun:` specifier — Node's resolver
 * rejects the protocol before the alias is consulted ("Only URLs with a scheme
 * in: file, data, and node are supported"), so the handler has to sit in front
 * of resolution instead.
 *
 * Needed because route handlers now delegate to `apps/api` use-cases, whose db
 * client imports `bun:sqlite` at module scope. Without this, every test that
 * touches a delegating route fails at collection and reports "no tests", which
 * reads as a missing file rather than a broken environment.
 */
function bunSqliteStub(): Plugin {
	const stub = resolve(__dirname, "stubs/bun-sqlite.ts")
	const clientStub = resolve(__dirname, "stubs/api-db-client.ts")
	const openSseRoot = resolve(__dirname, "../apps/web/open-sse")
	return {
		name: "9router:bun-sqlite-stub",
		enforce: "pre",
		resolveId(source, importer) {
			if (source === "bun:sqlite") return stub
			// `open-sse` is a directory of modules, not a package: it has no `package.json` and
			// is absent from node_modules, so `resolve.alias` is never consulted for the bare
			// `open-sse/index` specifier — Vite treats it as a package name and fails with
			// "Cannot find package". Resolving it here, where the alias pass cannot, keeps the
			// engine's side-effect imports working. Subpath imports use the alias below.
			if (source === "open-sse") return resolve(openSseRoot, "index.ts")
			if (source.startsWith("open-sse/")) return resolve(openSseRoot, `${source.slice(9)}.ts`)
			// The api's db client imports `bun:sqlite` at module scope and opens a
			// handle immediately; resolving the whole file for a test that only
			// reaches a use-case would drag the native binding in. Substitute the
			// module instead of its import.
			if (source.endsWith("infrastructure/db/client.ts")) return clientStub
			return null
		},
		load(id) {
			if (id === "bun:sqlite" || id === stub) return readFileSync(stub, "utf8")
			if (id === clientStub) return readFileSync(clientStub, "utf8")
			return null
		},
	}
}

export default defineConfig({
	plugins: [bunSqliteStub()],
	test: {
		environment: "node",
		globals: true,
		include: ["**/*.test.ts"],
		// Don't scan into git worktrees nested under .claude/ - they carry their
		// own copies of the test files but lack an installed node_modules (open-sse,
		// etc.), which makes provider imports fail during collection.
		//
		// Files written against node:test are NOT vitest tests: vitest runs none of
		// their assertions and fails the file with "No test suite found", which
		// reports 0 failed assertions and slips past the regression gate. So a
		// node:test file must be excluded here, not silently collected.
		// kimchi / kimchi-strip-reasoning / cline-auth used to be excluded for that
		// reason, but all three now import from "vitest" and pass — keeping them out
		// only hid 34 assertions from the gate.
		exclude: [
			"**/node_modules/**",
			"**/.claude/**",
			"**/dist/**",
			// Unit tests for the separate cloud worker (cloud/src/handlers/...). That
			// worker is not part of this repository, so this file can never collect
			// here — it belongs in the cloud repo's own suite.
			"unit/embeddings.cloud.test.ts",
		],
		// Allow many it.concurrent cases (real provider smoke runs ~50 providers in parallel)
		maxConcurrency: 60,
		// Suppress noisy console output from handlers under test
		silent: false,
		// Point DATA_DIR at a throwaway temp dir before any module reads it, so the
		// suite can never write to the developer's real ~/.9router database.
		setupFiles: ["./setup/isolateDataDir.js"],
	},
	resolve: {
		// Use array form so subpath aliases (e.g. "@9router/db") resolve correctly.
		alias: [
			// The engine moved to apps/web/open-sse with the monorepo split; the
			// root open-sse/ directory is now empty, so aliasing to it resolved
			// every "open-sse/..." import to a path that does not exist.
			//
			// Extensionless: the source writes `open-sse/executors/index`, but the file is
			// `index.ts`, and an alias replacement is not extension-resolved the way a normal
			// import is. The `resolveId` plugin above completes these to a real file.
			{ find: /^open-sse(\/|$)/, replacement: resolve(__dirname, "../apps/web/open-sse") + "/" },
			// `@/` is the Next app's own root alias. It pointed at ../src, which
			// stopped existing when the Next app moved to apps/web; every test
			// importing "@/..." then failed on module resolution instead of on an
			// assertion, which is worse — a broken import reports as a failed file,
			// not a failed expectation, so nobody reads it as a regression.
			{ find: /^@\//, replacement: resolve(__dirname, "../apps/web/src") + "/" },
			// Next route handlers now delegate to `apps/api` use-cases, whose db
			// client imports `bun:sqlite`. Vite has no such builtin, so any test
			// touching a delegating route failed at collection. The alias points
			// `server-only` is a marker package Next resolves at build time and Vite
			// cannot find. It carries no runtime behaviour, so an empty module keeps
			// the guard meaningful in the app and harmless here.
			{ find: "server-only", replacement: resolve(__dirname, "./shims/server-only.ts") },
		],
	},
})
