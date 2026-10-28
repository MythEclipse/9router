/**
 * Test stand-in for `apps/api`'s database client.
 *
 * The real module imports `bun:sqlite` and opens a handle at call time. Vitest
 * runs on Node, so resolving that specifier fails the entire module graph —
 * including tests that only wanted a use-case's business rules and never touch
 * a database.
 *
 * Substituting the client keeps the native binding out of the graph. A test
 * that reaches {@link createDb} is one that forgot to inject a repository port,
 * so it fails loudly instead of silently operating on an empty in-memory file.
 */

export type Db = unknown

export function resolveDataDir(configured?: string): string {
	return configured && configured.length > 0 ? configured : "/tmp/9router-test-data"
}

export function databaseFile(dataDir: string): string {
	return `${dataDir}/db/data.sqlite`
}

export function createDb(_dataDir: string): never {
	throw new Error(
		"apps/api createDb was called inside a Vitest run. Inject a repository port " +
			"instead of opening the database, or run the test under `bun test`.",
	)
}
