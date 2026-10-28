import Database from "better-sqlite3"
import { PRAGMA_SQL } from "../schema.ts"
import type { DbParams, DbRow, DbRunResult, ResolvedDbAdapter } from "../types.ts"

/** A prepared statement from better-sqlite3, as this adapter caches them. */
type BetterStatement = ReturnType<InstanceType<typeof Database>["prepare"]>
/** One positional bind value better-sqlite3 accepts. */
type SqliteValue = string | number | bigint | Uint8Array | null

/**
 * Bridge DbParams (a plain array) to the rest tuple better-sqlite3 expects.
 * TypeScript only spreads a tuple into a rest parameter, never a plain array.
 */
function toBindings(params: DbParams): [SqliteValue[]] {
	return [params as SqliteValue[]]
}

// Periodic checkpoint to keep WAL file small (avoid huge -wal/-shm growth)
const CHECKPOINT_INTERVAL_MS = 60 * 1000

export function createBetterSqliteAdapter(filePath: string): ResolvedDbAdapter {
	const db = new Database(filePath)
	db.exec(PRAGMA_SQL)
	// Schema is created/synced by migrate.js after adapter init

	const stmtCache = new Map<string, BetterStatement>()

	function prepare(sql: string): BetterStatement {
		let stmt = stmtCache.get(sql)
		if (!stmt) {
			stmt = db.prepare(sql)
			stmtCache.set(sql, stmt)
		}
		return stmt
	}

	// Truncate WAL periodically so file stays small for backup/copy
	const checkpointTimer = setInterval(() => {
		try {
			db.pragma("wal_checkpoint(TRUNCATE)")
		} catch {}
	}, CHECKPOINT_INTERVAL_MS)
	if (typeof checkpointTimer.unref === "function") checkpointTimer.unref()

	function gracefulClose() {
		try {
			db.pragma("wal_checkpoint(TRUNCATE)")
		} catch {}
		try {
			stmtCache.clear()
		} catch {}
		try {
			db.close()
		} catch {}
	}

	// Ensure WAL is flushed and -wal/-shm files removed on shutdown
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

	// See nodeSqliteAdapter: a rebuilt adapter must not leave its handlers (and a
	// closed database) attached for the life of the process.
	function detachShutdownHandlers() {
		process.off("beforeExit", onShutdown)
		process.off("SIGINT", onSigint)
		process.off("SIGTERM", onSigterm)
	}

	return {
		driver: "better-sqlite3",
		// better-sqlite3 takes its bind values as a rest tuple, while DbParams is a
		// plain array; the cast is the one place that difference is bridged.
		// Each method is annotated against ResolvedDbAdapter so the return types
		// stay checked while the generic parameter is read from `this`.
		run(sql: string, params: DbParams = []): DbRunResult {
			const stmt = prepare(sql)
			const r = stmt.run.apply(stmt, toBindings(params))
			return { changes: Number(r.changes ?? 0), lastInsertRowid: Number(r.lastInsertRowid ?? 0) }
		},
		get<T = DbRow>(sql: string, params: DbParams = []): T | undefined {
			const stmt = prepare(sql)
			return stmt.get.apply(stmt, toBindings(params)) as T | undefined
		},
		all<T = DbRow>(sql: string, params: DbParams = []): T[] {
			const stmt = prepare(sql)
			return stmt.all.apply(stmt, toBindings(params)) as T[]
		},
		exec(sql) {
			return db.exec(sql)
		},
		transaction(fn) {
			return db.transaction(fn)()
		},
		checkpoint() {
			try {
				db.pragma("wal_checkpoint(TRUNCATE)")
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
