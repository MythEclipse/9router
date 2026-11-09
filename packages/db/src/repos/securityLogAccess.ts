/**
 * Access trail: dashboard/API requests minus the LLM streams.
 *
 * Extracted verbatim from securityLogRepo.ts.
 */

import { getAdapter } from "../driver.ts"
import type { DbAdapter } from "../types.ts"

// ---------------------------------------------------------------------------
// Access trail (dashboard/API requests minus the LLM streams).
// ---------------------------------------------------------------------------

// Kept small enough that the UI can read it whole: this is "what touched the
// door recently", not a flow to replay.
const ACCESS_KEEP = 1200

function ensureAccessTable(db: DbAdapter): void {
	db.run(`CREATE TABLE IF NOT EXISTS accessEvents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    method TEXT,
    path TEXT,
    status INTEGER DEFAULT 0,
    ms INTEGER DEFAULT 0,
    ip TEXT,
    role TEXT
  )`)
	db.run(`CREATE INDEX IF NOT EXISTS idx_ae_at ON accessEvents(at DESC)`)
}

/** A dashboard access to record: who hit what, how long it took. */
export interface AccessEventInput {
	at?: string
	method?: string
	path?: string
	status?: number | string
	ms?: number | string
	ip?: string
	role?: string
}

export async function recordAccessEvent(input: AccessEventInput = {}): Promise<void> {
	try {
		const db = await getAdapter()
		ensureAccessTable(db)
		db.run(
			`INSERT INTO accessEvents(at, method, path, status, ms, ip, role) VALUES(?, ?, ?, ?, ?, ?, ?)`,
			[
				input.at || new Date().toISOString(),
				String(input.method || "")
					.toUpperCase()
					.slice(0, 8),
				String(input.path || "").slice(0, 300),
				Number(input.status) || 0,
				Number(input.ms) || 0,
				String(input.ip || "").slice(0, 64),
				String(input.role || "anonymous").slice(0, 24),
			],
		)
		// Trim in place so a forgotten dashboard tab cannot grow this forever.
		db.run(`DELETE FROM accessEvents WHERE id <= (SELECT MAX(id) - ? FROM accessEvents)`, [
			ACCESS_KEEP,
		])
	} catch (error) {
		console.error(
			"[security-log] access write failed:",
			error instanceof Error ? error.message : error,
		)
	}
}

export async function getAccessEvents({ limit = 200 } = {}) {
	const db = await getAdapter()
	ensureAccessTable(db)
	const capped = Math.max(1, Math.min(Number(limit) || 200, ACCESS_KEEP))
	const list = db.all(`SELECT * FROM accessEvents ORDER BY id DESC LIMIT ?`, [capped])
	return (list || []).map((row) => ({
		at: row.at,
		method: row.method || "",
		path: row.path || "",
		status: Number(row.status) || 0,
		ms: Number(row.ms) || 0,
		ip: row.ip || "",
		role: row.role || "anonymous",
	}))
}
