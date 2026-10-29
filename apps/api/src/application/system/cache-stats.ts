/**
 * Hit/miss counters for the response cache.
 *
 * The cache toggle is otherwise unfalsifiable from the UI: there is no way to
 * tell a cache that never hits from one that is saving every repeat prompt. The
 * counters live in the engine (`open-sse/rtk/semanticCache`), so this use-case is
 * only the seam that lets the route be tested without starting the engine — the
 * port is a plain pair of functions, nothing more.
 */

export interface SemanticCacheStats {
	readonly hits: number
	readonly misses: number
	readonly saves: number
	readonly evictions: number
	readonly entries: number
	readonly ttlMs: number
}

export interface SemanticCachePort {
	read(): SemanticCacheStats
	resetCounters(): void
}

export function makeCacheStats(cache: SemanticCachePort) {
	return {
		/** Reading never resets; a dashboard poll must not clear what it measures. */
		async read(): Promise<SemanticCacheStats> {
			return cache.read()
		},

		/**
		 * Clear the counters and answer with the zeroed snapshot in one round trip,
		 * so a client that resets can render the result without a second call.
		 */
		async reset(): Promise<SemanticCacheStats> {
			cache.resetCounters()
			return cache.read()
		},
	}
}
