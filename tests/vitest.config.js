import { defineConfig } from "vitest/config";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["**/*.test.js"],
    // Don't scan into git worktrees nested under .claude/ — they carry their
    // own copies of the test files but lack an installed node_modules (open-sse,
    // etc.), which makes provider imports fail during collection.
    // Files written against node:test are NOT vitest tests: vitest collects them
    // via the **/*.test.js glob, runs none of their assertions, and then fails
    // the file with "No test suite found" — which reported 0 failed assertions
    // and therefore slipped past the regression gate. The three that still exist
    // run explicitly in the "node:test suites" step of ci.yml instead.
    // (tests/auth/saml.test.js was a subset of tests/unit/saml.test.js and has
    // been deleted; the vitest twin covers every function it did.)
    exclude: [
      "**/node_modules/**",
      "**/.claude/**",
      "**/dist/**",
      "unit/kimchi.test.js",
      "unit/kimchi-strip-reasoning.test.js",
      "unit/cline-auth.test.js",
      // Unit tests for the separate cloud worker (cloud/src/handlers/...). That
      // worker is not part of this repository, so this file can never collect
      // here — it belongs in the cloud repo's own suite.
      "unit/embeddings.cloud.test.js",
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
      { find: /^open-sse\//, replacement: resolve(__dirname, "../open-sse") + "/" },
      { find: "open-sse", replacement: resolve(__dirname, "../open-sse") },
      { find: /^@\//, replacement: resolve(__dirname, "../src") + "/" },
    ],
  },
});
