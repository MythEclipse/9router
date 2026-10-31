import type { DbAdapter } from "../types.ts"
import type { Migration } from "./index.ts"

/**
 * Latency and cache provenance on `usageHistory`.
 *
 * The additive sync in `migrate.ts` would add these columns on its own, so this migration
 * exists for the other half of the job: the backfill decision. Existing rows keep `NULL`
 * latency, which reads as "not measured" — the honest answer for a request that finished
 * before the columns existed. Writing `0` instead would put a year of instant responses into
 * every percentile the dashboard draws.
 *
 * `PRAGMA table_info` is checked first because a database that bootstrapped from
 * `TABLES` already has the columns and `ALTER TABLE … ADD COLUMN` would throw.
 */

/** The columns this migration adds, in the order they are declared in `schema.ts`. */
const LATENCY_COLUMNS: ReadonlyArray<readonly [name: string, definition: string]> = [
	["latencyMs", "INTEGER"],
	["ttftMs", "INTEGER"],
	["cached", "INTEGER DEFAULT 0"],
]

const migration: Migration = {
	version: 6,
	name: "usage latency and cache provenance",
	up(db: DbAdapter) {
		const columns = db.all<{ name: string }>("PRAGMA table_info(usageHistory)")
		// A database old enough to predate `usageHistory` entirely (a v1 fixture, an install that
		// only ever used the key tables) gets the table — with these columns — from the additive
		// sync that runs after the journal. Indexing a table that does not exist yet would fail
		// the whole migration run and leave the database on version 5 forever.
		if (columns.length === 0) return

		const present = new Set(columns.map((column) => column.name))
		for (const [name, definition] of LATENCY_COLUMNS) {
			if (present.has(name)) continue
			db.exec(`ALTER TABLE usageHistory ADD COLUMN ${name} ${definition}`)
		}
		// Percentiles are read as "every finished row in the window", which the timestamp
		// index already serves. This partial index is for the other shape: a report that
		// only wants rows that carry a measurement, on an install where most do not.
		db.exec(
			"CREATE INDEX IF NOT EXISTS idx_uh_latency ON usageHistory(timestamp DESC) WHERE latencyMs IS NOT NULL",
		)
	},
}

export default migration
