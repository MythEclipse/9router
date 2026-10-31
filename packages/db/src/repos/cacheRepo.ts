/**
 * The prompt cache's storage, on the `kv` table.
 *
 * The cache used to be a `Map` in the request handler, which made a restart look like a cold
 * install and gave every process its own private copy. Nothing about a cached answer is
 * process-local, so it belongs on disk — and `kv` is already the table for "a small value
 * keyed by a scope", which is exactly the shape.
 *
 * Three properties this module owns, because the caller cannot see them:
 *
 * 1. **A row is one entry, addressed by its hash.** The key column is the hash the caller
 *    computed; the value is the JSON payload. Two writers of the same hash overwrite rather
 *    than duplicate, so a cache cannot grow by re-answering the same prompt.
 * 2. **`expiresAt` is stored, not inferred.** A TTL that lives only in the reader's head
 *    cannot survive a restart, and the entry would come back with a fresh lifetime every
 *    boot. The writer stamps the deadline and the reader honours it.
 * 3. **Pruning is the writer's job.** A cache with a TTL but no sweeper is a table that only
 *    grows; `pruneCacheScope` runs beside the write and drops what has expired.
 *
 * The scope is a constant per cache (`semanticCache`), so an unrelated feature that later
 * wants a small persistent keyed store can use its own scope without touching this one.
 */
import { getAdapter } from "../driver.ts"
import { parseJson, stringifyJson } from "../helpers/jsonCol.ts"
import type { DbRow, ResolvedDbAdapter } from "../types.ts"

/** One stored entry: the payload plus the deadline the writer promised. */
export interface CacheEntryRecord<T> {
	readonly value: T
	/** Epoch milliseconds after which the entry is dead. */
	readonly expiresAt: number
}

/**
 * Every live entry of a scope, keyed by hash.
 *
 * Expired rows are filtered here rather than deleted: a read path that writes is a read path
 * that can fail under a read-only database, and the sweeper already runs on the write side.
 * An unreadable table answers an empty map — a cold cache, never a failed request.
 */
export async function readCacheScope<T>(scope: string, now = Date.now()): Promise<Map<string, T>> {
	const entries = new Map<string, T>()
	try {
		const db = await getAdapter()
		const rows = db.all<DbRow>(`SELECT key, value FROM kv WHERE scope = ?`, [scope])
		for (const row of rows) {
			const record = parseJson<CacheEntryRecord<T> | null>(String(row.value ?? ""), null)
			if (!record || typeof record !== "object") continue
			if (typeof record.expiresAt !== "number" || record.expiresAt <= now) continue
			entries.set(String(row.key), record.value)
		}
	} catch (e) {
		console.error(`[cache] failed to read scope ${scope}:`, e instanceof Error ? e.message : e)
	}
	return entries
}

/** Store one entry, replacing any previous value for the same hash. */
export async function writeCacheEntry<T>(
	scope: string,
	key: string,
	value: T,
	expiresAt: number,
): Promise<void> {
	try {
		const db = await getAdapter()
		db.run(
			`INSERT INTO kv(scope, key, value) VALUES(?, ?, ?)
			 ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
			[scope, key, stringifyJson({ value, expiresAt } satisfies CacheEntryRecord<T>)],
		)
	} catch (e) {
		// A cache that cannot write is a cache miss, not a failed request.
		console.error(`[cache] failed to write scope ${scope}:`, e instanceof Error ? e.message : e)
	}
}

/** Drop one entry. Used when a response is known to be unusable. */
export async function dropCacheEntry(scope: string, key: string): Promise<void> {
	try {
		const db = await getAdapter()
		db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [scope, key])
	} catch (e) {
		console.error(`[cache] failed to drop ${scope}/${key}:`, e instanceof Error ? e.message : e)
	}
}

/** Drop a whole scope, for the "clear cache" control. */
export async function dropCacheScope(scope: string): Promise<number> {
	try {
		const db = await getAdapter()
		const before = countOfScope(db, scope)
		db.run(`DELETE FROM kv WHERE scope = ?`, [scope])
		return before
	} catch (e) {
		console.error(`[cache] failed to clear scope ${scope}:`, e instanceof Error ? e.message : e)
		return 0
	}
}

/**
 * Remove expired entries, and — when the scope is over `maxEntries` — the oldest survivors.
 *
 * Both halves matter. Expiry alone leaves an unbounded table when every entry is fresh (a
 * burst of distinct prompts inside one TTL), and a cap alone keeps dead rows forever. The
 * cap is enforced by `expiresAt` ascending, which is the same order the cache would have
 * evicted in memory.
 */
export async function pruneCacheScope(
	scope: string,
	options: { maxEntries: number; now?: number },
): Promise<number> {
	const now = options.now ?? Date.now()
	const maxEntries = Math.max(1, Math.trunc(options.maxEntries))
	try {
		const db = await getAdapter()
		const rows = db.all<DbRow>(`SELECT key, value FROM kv WHERE scope = ?`, [scope])
		const dead: string[] = []
		const alive: Array<{ key: string; expiresAt: number }> = []
		for (const row of rows) {
			const record = parseJson<CacheEntryRecord<unknown> | null>(String(row.value ?? ""), null)
			const expiresAt = typeof record?.expiresAt === "number" ? record.expiresAt : 0
			if (expiresAt <= now) dead.push(String(row.key))
			else alive.push({ key: String(row.key), expiresAt })
		}
		const overflow = Math.max(0, alive.length - maxEntries)
		if (overflow > 0) {
			alive.sort((a, b) => a.expiresAt - b.expiresAt)
			for (const entry of alive.slice(0, overflow)) dead.push(entry.key)
		}
		for (const key of dead) db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [scope, key])
		return dead.length
	} catch (e) {
		console.error(`[cache] failed to prune scope ${scope}:`, e instanceof Error ? e.message : e)
		return 0
	}
}

function countOfScope(db: ResolvedDbAdapter, scope: string) {
	const row = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM kv WHERE scope = ?`, [scope])
	return Number(row?.n ?? 0)
}
