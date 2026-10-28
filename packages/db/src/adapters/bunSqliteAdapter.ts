// Bun runtime adapter - uses built-in bun:sqlite (native, fastest under Bun).
// Loaded only when process.versions.bun is present.
import { PRAGMA_SQL } from "../schema.ts"
import type { DbParams, DbRow, DbRunResult, ResolvedDbAdapter } from "../types.ts"

// bun:sqlite exports no declarations this package depends on beyond the handle
// itself, so the statement type is derived from it rather than imported.
type BunStatement = ReturnType<InstanceType<typeof import("bun:sqlite").Database>["prepare"]>
/** One positional bind value bun:sqlite accepts. */
type SqliteValue = string | number | bigint | Uint8Array | null

const CHECKPOINT_INTERVAL_MS = 60 * 1000

export async function createBunSqliteAdapter(filePath: string): Promise<ResolvedDbAdapter> {
	// Dynamic import - only resolves under Bun runtime
	const { Database } = await import("bun:sqlite")
	const db = new Database(filePath, { create: true })
	db.exec(PRAGMA_SQL)

	const stmtCache = new Map<string, BunStatement>()
	function prepare(sql: string): BunStatement {
		let stmt = stmtCache.get(sql)
		if (!stmt) {
			stmt = db.prepare(sql)
			stmtCache.set(sql, stmt)
		}
		return stmt
	}

	const checkpointTimer = setInterval(() => {
		try {
			db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
		} catch {}
	}, CHECKPOINT_INTERVAL_MS)
	if (typeof checkpointTimer.unref === "function") checkpointTimer.unref()

	function gracefulClose() {
		try {
			db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
		} catch {}
		try {
			stmtCache.clear()
		} catch {}
		try {
			db.close()
		} catch {}
	}
	const onShutdown = () => gracefulClose()
	const onSigint = () => {
		onShutdown()
		process.exit(0)
	}
	const onSigterm = () => {
		onShutdown()
		process.exit(0)
	}
	process.once("beforeExit", onShutdown)
	process.once("SIGINT", onSigint)
	process.once("SIGTERM", onSigterm)

	// See nodeSqliteAdapter: a rebuilt adapter must not leave its handlers behind.
	function detachShutdownHandlers() {
		process.off("beforeExit", onShutdown)
		process.off("SIGINT", onSigint)
		process.off("SIGTERM", onSigterm)
	}

	return {
		driver: "bun:sqlite",
		run(sql: string, params: DbParams = []): DbRunResult {
			// bun:sqlite types the run result as unknown; it is the same
			// changes/lastInsertRowid pair the other drivers return.
			const r = prepare(sql).run(...(params as SqliteValue[])) as {
				changes?: number | bigint
				lastInsertRowid?: number | bigint
			}
			return { changes: Number(r.changes ?? 0), lastInsertRowid: Number(r.lastInsertRowid ?? 0) }
		},
		get<T = DbRow>(sql: string, params: DbParams = []): T | undefined {
			return prepare(sql).get(...(params as SqliteValue[])) as T | undefined
		},
		all<T = DbRow>(sql: string, params: DbParams = []): T[] {
			return prepare(sql).all(...(params as SqliteValue[])) as T[]
		},
		exec(sql) {
			return db.exec(sql)
		},
		transaction(fn) {
			// bun:sqlite has db.transaction() API (similar to better-sqlite3)
			const tx = db.transaction(fn)
			return tx()
		},
		checkpoint() {
			try {
				db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
			} catch {}
		},
		close() {
			clearInterval(checkpointTimer)
			detachShutdownHandlers()
			gracefulClose()
		},
		raw: db,
	}
}
