/**
 * Migration orchestrator.
 *
 * Extracted from migrate.ts: versioned-migration/schema logic lives in
 * migrateSchema.ts, the one-time legacy-JSON import in migrateLegacy.ts, and
 * the error type in migrateTypes.ts. This file keeps the entry point and the
 * marker-file bookkeeping; the legacy import helpers are re-exported so
 * existing importers keep working.
 */

import fs from "node:fs"
import path from "node:path"
import { backupDbLite, backupFile, makeBackupDir, pruneOldBackups } from "./backup.ts"
import { getMetaSync, setMetaSync } from "./helpers/metaStore.ts"
import {
	importLegacyDetails,
	importLegacyDisabled,
	importLegacyMain,
	importLegacyUsage,
	readJsonSafe,
} from "./migrateLegacy.ts"
import { MigrationAborted } from "./migrateTypes.ts"
import { DB_DIR, LEGACY_FILES } from "./paths.ts"
import { buildCreateTableSql, SCHEMA_VERSION, TABLES } from "./schema.ts"
import type { DbAdapter } from "./types.ts"
import { getAppVersion } from "./version.ts"

export { MigrationAborted }

import {
	errMessage,
	isFreshDb,
	runVersionedMigrations,
	syncSchemaFromTables,
} from "./migrateSchema.ts"

// Marker file: prevents re-importing legacy JSON when user wipes data.sqlite.
const MIGRATED_MARKER = path.join(DB_DIR, ".migrated-from-json")

// Track per-adapter so reusing same adapter skips re-run, but new adapter (after reset) re-runs.
const _migratedAdapters = new WeakSet()

// ─── Main entry ──────────────────────────────────────────────────────────
export async function runMigrationOnce(adapter: DbAdapter) {
	if (_migratedAdapters.has(adapter)) return
	_migratedAdapters.add(adapter)

	// Capture freshness BEFORE migrations stamp _meta (otherwise we'd misclassify
	// a brand-new DB as non-fresh once schemaVersion is written).
	const fresh = isFreshDb(adapter)

	// Prune stale backups every boot so old oversized backups shrink to KEEP.
	pruneOldBackups()

	// Bootstrap _meta so we can read the stored backup schema version below
	// (runVersionedMigrations also ensures this, but we need it earlier here).
	adapter.exec(buildCreateTableSql("_meta", TABLES._meta))

	// Detect a pending schema change via the central SCHEMA_VERSION const.
	// A lightweight backup is taken BEFORE any schema mutation below.
	const storedSchemaVer = parseInt(getMetaSync(adapter, "backupSchemaVersion", "0") ?? "0", 10) || 0
	const schemaChanging = !fresh && storedSchemaVer < SCHEMA_VERSION
	if (schemaChanging) {
		try {
			const backupDir = makeBackupDir(`schema-${storedSchemaVer}-to-${SCHEMA_VERSION}`)
			backupDbLite(adapter, backupDir)
			pruneOldBackups()
			console.log(
				`[DB][migrate] pre-schema backup ${storedSchemaVer} → ${SCHEMA_VERSION}: ${backupDir}`,
			)
		} catch (e) {
			console.warn(`[DB][migrate] pre-schema backup failed (continuing): ${errMessage(e)}`)
		}
	}

	// 1. Always run versioned migrations chain (skip-version safe)
	const _migInfo = runVersionedMigrations(adapter)

	// 2. Additive sync (auto add missing columns/indexes declared in TABLES)
	syncSchemaFromTables(adapter)

	// Stamp the schema version we just reached so future boots skip re-backup.
	setMetaSync(adapter, "backupSchemaVersion", SCHEMA_VERSION)

	// 3. One-time legacy JSON import (only if DB was fresh on entry)
	const alreadyImported = fs.existsSync(MIGRATED_MARKER)
	const legacyMain = readJsonSafe(LEGACY_FILES.main)
	const legacyUsage = readJsonSafe(LEGACY_FILES.usage)
	const legacyDisabled = readJsonSafe(LEGACY_FILES.disabled)
	const legacyDetails = readJsonSafe(LEGACY_FILES.details)
	const hasLegacy = !!(legacyMain || legacyUsage || legacyDisabled || legacyDetails)

	if (fresh && hasLegacy && !alreadyImported) {
		const t0 = Date.now()
		const backupDir = makeBackupDir("migrate-from-json")
		for (const f of Object.values(LEGACY_FILES)) backupFile(f, backupDir)

		try {
			adapter.transaction(() => {
				importLegacyMain(adapter, legacyMain)
				importLegacyUsage(adapter, legacyUsage)
				importLegacyDisabled(adapter, legacyDisabled)
				importLegacyDetails(adapter, legacyDetails)
				setMetaSync(adapter, "appVersion", getAppVersion())
				setMetaSync(adapter, "backupSchemaVersion", SCHEMA_VERSION)
				setMetaSync(adapter, "migratedAt", new Date().toISOString())
			})
		} catch (err) {
			if (err instanceof MigrationAborted) {
				console.error(`[DB][migrate] aborted: ${err.message} | legacy JSON kept | backup: ${backupDir}`)
				return
			}
			throw err
		}

		try {
			fs.writeFileSync(MIGRATED_MARKER, new Date().toISOString())
		} catch {}
		pruneOldBackups()
		console.log(
			`[DB][migrate] JSON → SQLite in ${Date.now() - t0}ms | legacy JSON kept at DATA_DIR | backup: ${backupDir}`,
		)
		return
	}

	// Track app version for informational purposes only. App version bumps no
	// longer trigger a DB backup - only real schema changes (SCHEMA_VERSION) do.
	const newVer = getAppVersion()
	const oldVer = getMetaSync(adapter, "appVersion", null)
	if (oldVer !== newVer) setMetaSync(adapter, "appVersion", newVer)
}
