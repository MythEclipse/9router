import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

const __dirname = fileURLToPath(new URL(".", import.meta.url))

export default defineConfig({
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
		// Use array form so subpath aliases (e.g. "@/lib/db/index.js") resolve correctly.
		alias: [
			// The engine moved to apps/web/open-sse with the monorepo split; the
			// root open-sse/ directory is now empty, so aliasing to it resolved
			// every "open-sse/..." import to a path that does not exist.
			{ find: /^open-sse\//, replacement: resolve(__dirname, "../apps/web/open-sse") + "/" },
			{ find: "open-sse", replacement: resolve(__dirname, "../apps/web/open-sse") },
			// `@/` is the Next app's own root alias. It pointed at ../src, which
			// stopped existing when the Next app moved to apps/web; every test
			// importing "@/..." then failed on module resolution instead of on an
			// assertion, which is worse — a broken import reports as a failed file,
			// not a failed expectation, so nobody reads it as a regression.
			{ find: /^@\//, replacement: resolve(__dirname, "../apps/web/src") + "/" },
		],
	},
})
