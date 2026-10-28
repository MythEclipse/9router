import fs from "node:fs"
import initSqlJs, { type SqlJsStatic, type SqlJsValue } from "sql.js"
import { PRAGMA_SQL } from "../schema.ts"
import type { DbParams, DbRow, DbRunResult, ResolvedDbAdapter } from "../types.ts"

/** The wasm runtime, loaded once per process. */
let SQL: SqlJsStatic | null = null

// One process-hook registration for all sql.js adapters. Each adapter adds its
// flush function here and the single hook fans out to the live set, so opening
// and closing adapters repeatedly cannot accumulate EventEmitter listeners
// (which otherwise warns at 11 and, past that, hides the leak).
const shutdownFlushes = new Set<() => void>()
let shutdownHooksInstalled = false

function runAllFlushes() {
	for (const flush of shutdownFlushes) {
		try {
			flush()
		} catch {
			/* fail-open: one bad flush must not block the rest */
		}
	}
}

function registerShutdownFlush(flush: () => void) {
	shutdownFlushes.add(flush)
	if (shutdownHooksInstalled) return
	process.on("beforeExit", runAllFlushes)
	process.on("SIGINT", runAllFlushes)
	process.on("SIGTERM", runAllFlushes)
	shutdownHooksInstalled = true
}

function unregisterShutdownFlush(flush: () => void) {
	shutdownFlushes.delete(flush)
}

async function loadSql(): Promise<SqlJsStatic> {
	if (SQL) return SQL
	SQL = await initSqlJs()
	return SQL
}

export async function createSqlJsAdapter(filePath: string): Promise<ResolvedDbAdapter> {
	const SQLLib = await loadSql()
	const buf = fs.existsSync(filePath) ? fs.readFileSync(filePath) : null
	const db = new SQLLib.Database(buf)
	db.exec(PRAGMA_SQL)
	// Schema is created/synced by migrate.js after adapter init

	let dirty = false
	let saveTimer: ReturnType<typeof setTimeout> | null = null
	let transactionDepth = 0
	const SAVE_DEBOUNCE_MS = 100

	function persist(): void {
		try {
			const data = db.export()
			fs.writeFileSync(filePath, Buffer.from(data))
			dirty = false
		} catch (e) {
			console.error("[sqljs] persist error:", e)
		}
	}

	function scheduleSave(immediate: boolean = false): void {
		dirty = true
		if (saveTimer) {
			clearTimeout(saveTimer)
			saveTimer = null
		}
		if (immediate) {
			if (transactionDepth === 0) persist()
			return
		}
		saveTimer = setTimeout(() => {
			saveTimer = null
			if (dirty) persist()
		}, SAVE_DEBOUNCE_MS)
	}

	/**
	 * The binds to hand sql.js, or `undefined` to leave the statement unbound.
	 *
	 * `DbParams` is `unknown[]` because every driver accepts every column type;
	 * sql.js only takes a narrowed value list, so this is the boundary that
	 * narrows it — the same place the other adapters call their driver.
	 */
	function paramsObj(params?: DbParams): SqlJsValue[] | undefined {
		if (!params || params.length === 0) return undefined
		return params as SqlJsValue[]
	}

	function run(sql: string, params: DbParams = []): DbRunResult {
		const stmt = db.prepare(sql)
		try {
			stmt.bind(paramsObj(params))
			stmt.step()
			const changes = db.getRowsModified()
			const lastInsertRowid = Number(
				db.exec("SELECT last_insert_rowid() as id")[0]?.values?.[0]?.[0] ?? 0,
			)
			scheduleSave(true)
			return { changes, lastInsertRowid }
		} finally {
			stmt.free()
		}
	}

	function get<T = DbRow>(sql: string, params: DbParams = []): T | undefined {
		const stmt = db.prepare(sql)
		try {
			stmt.bind(paramsObj(params))
			if (stmt.step()) return stmt.getAsObject() as T
			return undefined
		} finally {
			stmt.free()
		}
	}

	function all<T = DbRow>(sql: string, params: DbParams = []): T[] {
		const stmt = db.prepare(sql)
		try {
			stmt.bind(paramsObj(params))
			const rows: T[] = []
			while (stmt.step()) rows.push(stmt.getAsObject() as T)
			return rows
		} finally {
			stmt.free()
		}
	}

	function exec(sql: string): void {
		db.exec(sql)
		scheduleSave(true)
	}

	function transaction<T>(fn: () => T): T {
		const sp = `sp_${Math.random().toString(36).slice(2)}`
		db.exec(`SAVEPOINT ${sp}`)
		transactionDepth++
		try {
			const result = fn()
			db.exec(`RELEASE ${sp}`)
			transactionDepth--
			scheduleSave(true)
			return result
		} catch (e) {
			try {
				db.exec(`ROLLBACK TO ${sp}`)
				db.exec(`RELEASE ${sp}`)
			} catch {}
			transactionDepth--
			if (transactionDepth === 0 && dirty) scheduleSave(true)
			throw e
		}
	}

	function close(): void {
		if (saveTimer) clearTimeout(saveTimer)
		if (dirty) persist()
		db.close()
		unregisterShutdownFlush(flush)
	}

	// Flush on shutdown. The process hooks are registered once per process and
	// fan out to every live adapter: registering per adapter leak-accumulates 3
	// listeners on each open/reopen (tests do this constantly) and trips
	// MaxListenersExceededWarning at 11.
	const flush = () => {
		if (dirty)
			try {
				persist()
			} catch {}
	}
	registerShutdownFlush(flush)

	return {
		// Must match DbDriverName in ../types (and what callers/tests expect): the
		// npm package is "sql.js", so report that id, not the adapter's file name.
		driver: "sql.js" as const,
		run,
		get,
		all,
		exec,
		transaction,
		// sql.js keeps everything in memory: there is no WAL to checkpoint.
		checkpoint() {},
		close,
		raw: db,
	}
}
