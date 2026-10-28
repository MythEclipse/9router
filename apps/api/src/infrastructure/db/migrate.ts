/**
 * Migration runner.
 *
 * Migrations are source-controlled SQL read from a journal beside this module,
 * resolved from `import.meta.url` — never `process.cwd()`. That distinction
 * matters: esbuild inlines JS and nothing else and REWRITES module depth, so a
 * fixed `../../../migrations` is correct unbundled (src/infrastructure/db/) and
 * wrong in the bundle (dist/), where it overshoots two levels. A shipped
 * payload would then find an empty directory and report success while applying
 * no schema — a running server on an empty database.
 *
 * The journal is therefore located by walking up from this module until a
 * directory actually containing `.sql` files is found. Missing everywhere is a
 * hard error, never an empty success.
 *
 * Each file runs once, recorded in `_migrations`, inside a transaction.
 */

import type { Database } from "bun:sqlite"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** How far above the module to look. src/infrastructure/db and dist/ both fit. */
const MAX_ASCENT = 5

/** A directory qualifies only if it holds at least one `.sql` file. */
function holdsSql(dir: string): boolean {
	if (!existsSync(dir)) return false
	return readdirSync(dir).some((f) => f.endsWith(".sql"))
}

/**
 * Locate the journal, or return null.
 *
 * `from` defaults to this module's directory, which is correct unbundled and
 * under esbuild. Turbopack is different: it rewrites `import.meta.url` to a
 * workspace-relative string, so the ascent starts somewhere meaningless and
 * every candidate misses. Callers therefore pass `migrationsDir` explicitly —
 * a bundler-aware entry point knows where it staged the journal, this module
 * does not.
 */
export function findMigrationsDir(
	from: string = dirname(fileURLToPath(import.meta.url)),
): string | null {
	let current = from
	for (let ascent = 0; ascent <= MAX_ASCENT; ascent += 1) {
		const candidate = join(current, "migrations")
		if (holdsSql(candidate)) return candidate
		// The bundle's own directory may already BE the journal copy.
		if (holdsSql(current)) return current
		const parent = dirname(current)
		if (parent === current) break
		current = parent
	}
	return null
}

export interface RunMigrationsOptions {
	/**
	 * Journal directory, for a host whose bundler rewrote `import.meta.url`.
	 * Passed as a plain path so the lookup does not depend on module identity.
	 */
	readonly migrationsDir?: string
}

export function runMigrations(
	sqlite: Database,
	dataDir: string,
	options: RunMigrationsOptions = {},
): void {
	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS _migrations (
			name TEXT PRIMARY KEY,
			applied_at INTEGER NOT NULL
		)
	`)

	const dir = options.migrationsDir
		? holdsSql(options.migrationsDir)
			? options.migrationsDir
			: null
		: findMigrationsDir()
	if (!dir) {
		throw new Error(
			`Migration journal not found${options.migrationsDir ? ` at ${options.migrationsDir}` : ""}. ` +
				"The build must copy migrations/ beside the bundled migrator; refusing to start on an empty schema.",
		)
	}

	const applied = new Set(
		(sqlite.query("SELECT name FROM _migrations").all() as { name: string }[]).map((r) => r.name),
	)

	const files = readdirSync(dir)
		.filter((f) => f.endsWith(".sql"))
		.sort()

	for (const file of files) {
		if (applied.has(file)) continue
		const sql = readFileSync(join(dir, file), "utf8")
		const apply = sqlite.transaction(() => {
			sqlite.exec(sql)
			sqlite.query("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(file, Date.now())
		})
		apply()
		console.log(`[db][migrate] applied ${file}`)
	}

	console.log(`[db][migrate] up to date at ${dataDir} (${files.length} migration(s))`)
}
