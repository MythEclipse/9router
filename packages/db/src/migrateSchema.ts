/**
 * Versioned migrations and additive schema sync.
 *
 * Extracted verbatim from migrate.ts.
 */

import { getMetaSync, setMetaSync } from "./helpers/metaStore.ts"
import { latestVersion, MIGRATIONS } from "./migrations/index.ts"
import { buildCreateTableSql, TABLES, type TableDef } from "./schema.ts"
import type { DbAdapter } from "./types.ts"

export function isFreshDb(adapter: DbAdapter) {
	// Table _meta may not exist yet on truly fresh DB
	try {
		const row = adapter.get(`SELECT COUNT(*) as c FROM _meta`)
		return !row || row.c === 0
	} catch {
		return true
	}
}

// ─── Versioned migrations runner (skip-version safe) ─────────────────────
/** The message of a caught value, which strict typing leaves as `unknown`. */
export function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

export function runVersionedMigrations(adapter: DbAdapter) {
	// Bootstrap _meta first so we can read schemaVersion
	adapter.exec(buildCreateTableSql("_meta", TABLES._meta))

	const current = parseInt(getMetaSync(adapter, "schemaVersion", "0") ?? "0", 10) || 0
	const target = latestVersion()
	if (current >= target) return { applied: 0, from: current, to: current }

	const pending = MIGRATIONS.filter((m) => m.version > current)
	let lastApplied = current
	for (const m of pending) {
		adapter.transaction(() => {
			m.up(adapter)
			setMetaSync(adapter, "schemaVersion", m.version)
		})
		lastApplied = m.version
		console.log(`[DB][migrate] applied #${m.version} ${m.name}`)
	}
	return { applied: pending.length, from: current, to: lastApplied }
}

// ─── Auto-sync (additive only): add missing tables/columns/indexes ───────
export function syncSchemaFromTables(adapter: DbAdapter) {
	for (const [tableName, def] of Object.entries(TABLES)) {
		// Create table if absent
		adapter.exec(buildCreateTableSql(tableName, def))

		// Diff columns
		const existing = adapter.all(`PRAGMA table_info(${tableName})`)
		const existingNames = new Set(existing.map((r) => String(r.name)))
		for (const [colName, colDef] of Object.entries(def.columns)) {
			if (!existingNames.has(colName)) {
				// SQLite ADD COLUMN restrictions: no PRIMARY KEY / UNIQUE w/o NULL ok.
				// We strip PRIMARY KEY / UNIQUE since those are only valid at create time.
				const safeDef = colDef
					.replace(/PRIMARY KEY( AUTOINCREMENT)?/i, "")
					.replace(/UNIQUE/i, "")
					.trim()
				try {
					adapter.exec(`ALTER TABLE ${tableName} ADD COLUMN ${colName} ${safeDef}`)
					console.log(`[DB][sync] +column ${tableName}.${colName}`)
				} catch (e) {
					console.warn(
						`[DB][sync] add column ${tableName}.${colName} failed: ${e instanceof Error ? e.message : String(e)}`,
					)
				}
			}
		}

		// Indexes (idempotent). A failure here does not corrupt anything, but it leaves
		// the table unindexed, which only shows up later as slow queries — so it is
		// reported the same way a failed column add is.
		for (const idx of (def as TableDef).indexes || []) {
			try {
				adapter.exec(idx)
			} catch (e) {
				console.warn(`[DB][sync] index failed: ${idx} | ${e instanceof Error ? e.message : String(e)}`)
			}
		}
	}
}
