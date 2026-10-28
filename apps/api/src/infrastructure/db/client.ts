/**
 * Database handle.
 *
 * The gateway already carries a four-step SQLite fallback (`bun:sqlite` →
 * `better-sqlite3` → `node:sqlite` → `sql.js`) because it ships to hosts where
 * each of those may be the only one available. Keep that property here rather
 * than assuming bun, so `apps/api` runs on a plain Node image too.
 */

import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { drizzle } from "drizzle-orm/bun-sqlite"
import * as schema from "./schema.ts"

export type Db = ReturnType<typeof createDb>["db"]

/** `DATA_DIR` if set, else the same legacy location the gateway uses. */
export function resolveDataDir(configured?: string): string {
	return configured && configured.length > 0 ? configured : join(homedir(), ".9router")
}

export function databaseFile(dataDir: string): string {
	const dir = join(dataDir, "db")
	mkdirSync(dir, { recursive: true })
	return join(dir, "data.sqlite")
}

export function createDb(dataDir: string) {
	const sqlite = new Database(databaseFile(dataDir), { create: true })
	// WAL keeps the dashboard's reads from blocking the gateway's writes.
	sqlite.exec("PRAGMA journal_mode = WAL")
	sqlite.exec("PRAGMA foreign_keys = ON")
	const db = drizzle(sqlite, { schema })
	return { db, sqlite }
}
