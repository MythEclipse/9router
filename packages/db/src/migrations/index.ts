// Migration registry - append new entries when schema changes.
// Each migration: { version: number, name: string, up(db): void }
// Versions MUST be unique and monotonically increasing.
import type { DbAdapter } from "../types.ts"
import m001 from "./001-initial.ts"
import m002 from "./002-drop-budget-groups.ts"
import m003 from "./003-drop-prd-docs.ts"
import m004 from "./004-drop-prd-builder.ts"
import m005 from "./005-api-key-endpoint-allowlist.ts"
import m006 from "./006-usage-latency.ts"

/** One entry of the versioned migration chain. */
export interface Migration {
	/** Unique, monotonically increasing; stamped into `_meta.schemaVersion`. */
	version: number
	/** Short human label, logged as `applied #<version> <name>`. */
	name: string
	/** Applies the change. Runs inside the runner's transaction. */
	up(db: DbAdapter): void
}

export const MIGRATIONS: Migration[] = [m001, m002, m003, m004, m005, m006].sort(
	(a, b) => a.version - b.version,
)

export function latestVersion(): number {
	return MIGRATIONS.length ? MIGRATIONS[MIGRATIONS.length - 1].version : 0
}
