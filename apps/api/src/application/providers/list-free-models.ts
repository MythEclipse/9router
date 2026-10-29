/**
 * The free-model list, served from a cache.
 *
 * Behaviour, stated once because the route had it implicit: a fresh entry is
 * served without a network call; otherwise the upstream is asked, and if that
 * fails a stale entry is served with a warning rather than an empty list. The
 * cache is injected so the process decides its lifetime and a test can move the
 * clock.
 */

import {
	type CacheEntry,
	type CacheReading,
	type FreeModel,
	freeModelsFrom,
	type KiloModel,
	readCache,
} from "../../domain/free-model-cache.ts"

/** How long a fetched list counts as fresh. */
export const CACHE_TTL_MS = 60 * 60 * 1000

export type FreeModelsResult =
	| { readonly kind: "fresh"; readonly models: FreeModel[] }
	| { readonly kind: "cached"; readonly models: FreeModel[] }
	| { readonly kind: "stale"; readonly models: FreeModel[]; readonly warning: string }
	| { readonly kind: "failed"; readonly message: string }

export interface FreeModelDependencies {
	/** Fetches the upstream catalogue. Throws when the upstream refuses. */
	readonly fetchCatalogue: () => Promise<readonly KiloModel[]>
	/** The per-process cache. */
	readonly cache: {
		read(): CacheEntry<FreeModel[]> | null
		write(entry: CacheEntry<FreeModel[]>): void
	}
	readonly now: () => number
	readonly ttlMs?: number
}

export function makeFreeModels({
	fetchCatalogue,
	cache,
	now,
	ttlMs = CACHE_TTL_MS,
}: FreeModelDependencies) {
	return {
		async list(): Promise<FreeModelsResult> {
			const reading: CacheReading<FreeModel[]> = readCache(cache.read(), now(), ttlMs)
			if (reading.kind === "fresh") return { kind: "cached", models: reading.value }

			try {
				const models = freeModelsFrom(await fetchCatalogue())
				cache.write({ value: models, storedAt: now() })
				return { kind: "fresh", models }
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				// A stale entry is the reason the cache exists: the dashboard keeps
				// showing the last known free list instead of an empty panel.
				if (reading.kind === "stale") {
					return { kind: "stale", models: reading.value, warning: message }
				}
				return { kind: "failed", message }
			}
		},
	}
}
