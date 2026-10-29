/**
 * Kilo's free model list, with its cache.
 *
 * The cache is a module-level variable in the route, which is a decision nobody
 * wrote down: it is per-process, it is never invalidated, and on a failure it
 * serves an entry past its own TTL. That last part is the point — a stale free
 * list beats an empty one — but "past its TTL" has to have a floor, or a process
 * that has been up for a month will serve a month-old catalogue as if it were
 * fresh without ever retrying upstream.
 */

/** 24 hours. Past this, a kept entry is no longer evidence of anything. */
export const MAX_STALE_MS = 24 * 60 * 60 * 1000

export interface CacheEntry<T> {
	readonly value: T
	readonly storedAt: number
}

export type CacheReading<T> =
	/** Still inside the TTL. */
	| { readonly kind: "fresh"; readonly value: T }
	/** Past the TTL but inside {@link MAX_STALE_MS}; usable if the fetch fails. */
	| { readonly kind: "stale"; readonly value: T }
	/** Absent, or so old it is no longer worth serving. */
	| { readonly kind: "empty" }

/**
 * How a stored entry may be used right now.
 *
 * `ttlMs` is the freshness window; `age` is measured against the injected clock
 * so a test does not have to wait an hour.
 */
export function readCache<T>(
	entry: CacheEntry<T> | null | undefined,
	now: number,
	ttlMs: number,
): CacheReading<T> {
	if (!entry) return { kind: "empty" }
	const age = now - entry.storedAt
	if (age < 0) return { kind: "empty" } // clock moved backwards; distrust it
	if (age < ttlMs) return { kind: "fresh", value: entry.value }
	if (age < MAX_STALE_MS) return { kind: "stale", value: entry.value }
	return { kind: "empty" }
}

/**
 * The free models in an upstream catalogue.
 *
 * Kilo marks the free tier with `isFree: true`. A model that does not say so is
 * not free; there is no second signal to fall back on, and guessing from the id
 * would start offering paid models under a "free" heading.
 */
export interface KiloModel {
	readonly id?: unknown
	readonly name?: unknown
	readonly isFree?: unknown
	readonly context_length?: unknown
}

export interface FreeModel {
	readonly id: unknown
	readonly name: unknown
	readonly isFree: true
	readonly context_length: number
}

export function freeModelsFrom(catalogue: readonly KiloModel[]): FreeModel[] {
	return catalogue
		.filter((model) => model?.isFree === true)
		.map((model) => ({
			id: model.id,
			name: model.name,
			isFree: true as const,
			context_length: typeof model.context_length === "number" ? model.context_length : 0,
		}))
}
