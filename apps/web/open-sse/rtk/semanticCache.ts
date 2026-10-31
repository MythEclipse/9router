/**
 * Prompt cache: exact-repeat answers, replayed without a second upstream call.
 *
 * Three things were wrong with the previous version, and they were the three things that decide
 * whether a cache is worth having:
 *
 * 1. **It refused every streamed request** (`if (body.stream) return null`). Almost every agent
 *    call streams, so the cache was disabled for its main use case and the toggle in the
 *    dashboard only ever proved itself on the requests nobody makes twice.
 * 2. **It lived in a `Map`.** A restart was a cold cache, and two workers each had their own
 *    copy of the same answers. The `kv` table is right there, and an answer is not
 *    process-local.
 * 3. **A hit left no trace in `usageHistory`.** The saving was counted in a counter that reset
 *    with the process, so "did this save me anything" could not be answered per key or per day.
 *
 * What is cached, and why in two shapes:
 *
 *  - A **non-streamed** answer is cached as the parsed body, because that is exactly what the
 *    next identical request must receive.
 *  - A **streamed** answer is cached as the client-bound bytes — the SSE frames *after*
 *    translation. Replaying them verbatim is the only format-agnostic option: synthesising a
 *    stream from a final body means re-implementing every client format's frame grammar
 *    (`message_start`/`content_block_delta`/…), which is the kind of code that is wrong for
 *    three of the four formats and silently corrupt for the fourth.
 *
 * The `Map` stays as the read path. `checkSemanticCache` is called synchronously before the
 * upstream request is built, and a database round-trip there would add a query to every request
 * to answer a question that is usually "miss". `kv` is the durable copy, hydrated on first use
 * and written through on every save, so a restart costs one read rather than a cold cache.
 */
import crypto from "node:crypto"
import {
	dropCacheScope,
	pruneCacheScope,
	readCacheScope,
	writeCacheEntry,
} from "@9router/db/repos/cacheRepo"

/** The `kv` scope this cache owns. */
const CACHE_SCOPE = "semanticCache"

/** Saves between sweeps of the durable copy. */
const PRUNE_EVERY_SAVES = 50

/** The largest streamed answer worth keeping, in characters. */
const MAX_STREAM_CHARS = 256 * 1024

/** A cached answer, in whichever shape it was produced. */
type CacheEntry =
	| { readonly kind: "json"; readonly response: unknown; readonly expiresAt: number }
	| { readonly kind: "sse"; readonly text: string; readonly expiresAt: number }

const responseCache = new Map<string, CacheEntry>()

// TTL is configurable because a three hour window is wrong for some workloads:
// a long agent session needs a long window, while a shared proxy on a fast
// rotating IP wants a short one so answers never go stale.
let cacheTtlMs = 3 * 60 * 60 * 1000 // 3 hours, the historical default
let maxEntries = 1000 // historical hard cap

let savesSincePrune = 0
let hydrated = false
let hydrating: Promise<void> | null = null

export function setSemanticCacheMaxEntries(n) {
	const v = Math.floor(Number(n))
	if (Number.isFinite(v) && v >= 10) maxEntries = Math.min(v, 10000)
}

export function getSemanticCacheMaxEntries() {
	return maxEntries
}

export function setSemanticCacheTtlMs(ms) {
	const n = Number(ms)
	if (!Number.isFinite(n) || n <= 0) return
	cacheTtlMs = Math.min(Math.max(n, 60 * 1000), 30 * 24 * 60 * 60 * 1000)
}

export function getSemanticCacheTtlMs() {
	return cacheTtlMs
}

// Counters make the saving visible. Without them the toggle is unfalsifiable:
// the user cannot tell a working cache from one that never hits.
const stats = { hits: 0, misses: 0, saves: 0, evictions: 0, streamHits: 0, persisted: 0 }

export function getSemanticCacheStats() {
	return { ...stats, entries: responseCache.size, ttlMs: cacheTtlMs }
}

export function resetSemanticCacheStats() {
	stats.hits = 0
	stats.misses = 0
	stats.saves = 0
	stats.evictions = 0
	stats.streamHits = 0
	stats.persisted = 0
}

function hashObject(obj) {
	try {
		return crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex")
	} catch {
		return null
	}
}

/**
 * The cache key: model plus the parts of the request that change the answer.
 *
 * Deliberately not the whole body: `stream`, `stream_options`, a request id or a metadata blob
 * do not change what the model says, and including them would make a streamed and a
 * non-streamed copy of the same question two entries that can never share.
 */
function keyOf(body, model) {
	if (!body) return null
	// A forced tool call is not a question with a stable answer; caching it would replay a
	// decision made for one turn.
	if (body.tool_choice && body.tool_choice !== "auto") return null
	return hashObject({
		model,
		messages: body.messages || body.input || body.contents || [],
		system: body.system,
		tools: body.tools,
	})
}

/**
 * Load the durable copy into memory, once.
 *
 * Called by the request path when the cache is enabled, not at import time: a module that opens
 * the database as a side effect of being imported is a module that cannot be loaded by a test,
 * a script or the dashboard without creating a file.
 *
 * Fire-and-forget by design: the first requests after a restart may miss while this runs, which
 * costs one upstream call each, and blocking the request path on a table read would cost every
 * request.
 */
export function hydrateSemanticCache(): Promise<void> {
	if (hydrated) return Promise.resolve()
	if (hydrating) return hydrating
	hydrating = (async () => {
		try {
			const stored = await readCacheScope<CacheEntry>(CACHE_SCOPE)
			for (const [key, entry] of stored) {
				if (entry && (entry.kind === "json" || entry.kind === "sse")) {
					responseCache.set(key, entry)
				}
			}
			hydrated = true
		} catch {
			// A cache that cannot load is an empty cache, not a failed request.
			hydrated = false
		} finally {
			hydrating = null
		}
	})()
	return hydrating
}

/** The live entry for a key, dropping it when it has expired. */
function liveEntry(hashKey: string): CacheEntry | null {
	const entry = responseCache.get(hashKey)
	if (!entry) return null
	if (Date.now() < entry.expiresAt) return entry
	responseCache.delete(hashKey)
	stats.evictions++
	return null
}

/**
 * A cached non-streamed answer, or `null`.
 *
 * `stream: true` requests must not take this path: their answer is cached as bytes, and handing
 * a JSON body to a client that asked for a stream produces a response it cannot parse.
 */
export function checkSemanticCache(body, model) {
	if (!body || body.stream) return null
	const hashKey = keyOf(body, model)
	if (!hashKey) return null

	const entry = liveEntry(hashKey)
	if (entry && entry.kind === "json") {
		stats.hits++
		return entry.response
	}
	stats.misses++
	return null
}

/**
 * A cached streamed answer as wire bytes, or `null`.
 *
 * The bytes are already in the client's format — they were captured after translation — so the
 * caller only has to set the content type and hand them back.
 */
export function checkSemanticCacheStream(body, model) {
	if (!body || !body.stream) return null
	const hashKey = keyOf(body, model)
	if (!hashKey) return null

	const entry = liveEntry(hashKey)
	if (entry && entry.kind === "sse") {
		stats.hits++
		stats.streamHits++
		return entry.text
	}
	stats.misses++
	return null
}

/** Write one entry to memory, the durable copy, and enforce the cap. */
function store(hashKey: string, entry: CacheEntry): void {
	responseCache.set(hashKey, entry)
	stats.saves++
	stats.persisted++
	void writeCacheEntry(CACHE_SCOPE, hashKey, entry, entry.expiresAt)

	if (responseCache.size > maxEntries) {
		// Oldest insertion first: `Map` preserves order, and an evicted entry is also dropped
		// from the durable copy by the sweeper below.
		const oldestKey = responseCache.keys().next().value
		if (oldestKey !== undefined) {
			responseCache.delete(oldestKey)
			stats.evictions++
		}
	}

	savesSincePrune += 1
	if (savesSincePrune >= PRUNE_EVERY_SAVES) {
		savesSincePrune = 0
		void pruneCacheScope(CACHE_SCOPE, { maxEntries })
	}
}

export function saveToSemanticCache(body, model, responseBody) {
	if (!body || body.stream || !responseBody) return
	// Ensure response was successful (no errors)
	if (responseBody.error || responseBody.is_error) return

	const hashKey = keyOf(body, model)
	if (!hashKey) return
	store(hashKey, { kind: "json", response: responseBody, expiresAt: Date.now() + cacheTtlMs })
}

/**
 * Cache a finished stream, as the bytes the client received.
 *
 * Refused when the capture is empty or larger than `MAX_STREAM_CHARS`: a truncated stream would
 * replay as a truncated answer, and a huge one would put a megabyte in a row that exists to save
 * a request.
 */
export function saveStreamToSemanticCache(body, model, text) {
	if (!body || !body.stream || typeof text !== "string") return
	if (text.length === 0 || text.length > MAX_STREAM_CHARS) return
	// An error frame is not an answer worth replaying to the next caller.
	if (text.includes('"error"') && !text.includes("[DONE]")) return

	const hashKey = keyOf(body, model)
	if (!hashKey) return
	store(hashKey, { kind: "sse", text, expiresAt: Date.now() + cacheTtlMs })
}

/** Drop everything, in memory and on disk. Used by the "clear cache" control. */
export async function clearSemanticCache(): Promise<number> {
	const removed = await dropCacheScope(CACHE_SCOPE)
	responseCache.clear()
	resetSemanticCacheStats()
	return removed
}
