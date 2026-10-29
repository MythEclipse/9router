/**
 * Turning an upstream model catalogue into picker entries.
 *
 * Called from:
 *   - `apps/api/src/application/providers/suggest-models.ts`
 *   - `apps/web/src/lib/providerConnectionHost.ts` (the filter table is injected,
 *     because two filters lean on `open-sse` registry data the web app builds at
 *     import time)
 *   - `tests/unit/domain-model-catalogue.test.ts`
 *
 * No existing file serves this purpose: the filters lived in
 * `providers/suggested-models/filters.ts` next to the route, mixed with the
 * import-time fallback table and a live-fetch cache. What is left here is the
 * pure part — given a raw catalogue, what entries may the picker offer.
 *
 * Reads and writes nothing: every function is catalogue-in, entries-out.
 *
 * User instruction, verbatim: "lanjut kenapa malah berhenti".
 */

/** One model entry as the suggested-models picker shows it. */
export interface SuggestedModel {
	readonly id: string
	readonly name: string
	readonly contextLength?: number
	readonly isFree?: boolean
}

/** Turns a raw upstream catalogue (unknown shape) into picker entries. */
export type CatalogueFilter = (models: unknown) => SuggestedModel[]

/**
 * Every filter type, with the filter that serves it.
 *
 * The two tables were separate in the route: `FILTERS` here, `FALLBACK_SUGGESTIONS`
 * there, keyed by the same strings. One key missing from either produced a 400 on
 * a type the other supported, so they are one table now.
 */
export interface CatalogueFilters {
	readonly filters: Readonly<Record<string, CatalogueFilter>>
	/**
	 * What to show when upstream is unreachable. A type without a fallback is
	 * still served — it just has nothing to fall back to.
	 */
	readonly fallbacks: Readonly<Record<string, readonly SuggestedModel[]>>
}

/** The filter for a type, or null when the type is unknown. */
export function filterFor(catalogue: CatalogueFilters, type: string): CatalogueFilter | null {
	return catalogue.filters[type] ?? null
}

/** The fallback entries for a type, empty when it has none. */
export function fallbackFor(catalogue: CatalogueFilters, type: string): readonly SuggestedModel[] {
	return catalogue.fallbacks[type] ?? []
}

/**
 * Normalise the body of an upstream `/models` response into an array.
 *
 * Three shapes arrive in practice: a bare array, `{ data: [...] }` which is the
 * OpenAI convention, and `{ models: [...] }`. One more is real and awkward —
 * minimax-code answers with a single object holding a `providers` map — and it is
 * wrapped in a one-element array so every filter keeps a single input contract
 * instead of each one growing its own shape check.
 */
export function toCatalogueArray(raw: unknown): unknown[] {
	if (Array.isArray(raw)) return raw
	if (raw !== null && typeof raw === "object") return [raw]
	return []
}

/** Where the choice between live, stored and built-in entries came from. */
export type CatalogueSource = "live" | "synced" | "fallback"

/** What the picker is shown, and how honest the response should be about it. */
export interface CatalogueAnswer {
	readonly data: readonly SuggestedModel[]
	readonly source: CatalogueSource
	/** Present only when `source` is not `live`: why the live list is missing. */
	readonly stale: boolean
	readonly message?: string
	readonly syncedAt?: string
}

/** The message a stale answer carries. */
export const STALE_MESSAGE =
	"Live model list is unavailable, showing the last synced models instead."

/** The message a built-in answer carries. */
export const UNAVAILABLE_MESSAGE =
	"Live model list is unavailable, showing built-in models instead."

/**
 * Choose what to answer when the live catalogue produced nothing usable.
 *
 * The preference is stored-before-built-in at every failure — a synced copy is
 * this install's own data, while the built-in table is whatever the build
 * captured — and the flag is what tells the panel to mark the list stale. The
 * route repeated this choice three times, once per failure path; writing it once
 * is what stops a fourth failure path from forgetting the flag.
 */
export function degradedAnswer(
	synced: { readonly data: readonly SuggestedModel[]; readonly syncedAt?: string } | null,
	builtIn: readonly SuggestedModel[],
): CatalogueAnswer {
	if (synced && synced.data.length > 0) {
		return {
			data: synced.data,
			source: "synced",
			stale: true,
			message: STALE_MESSAGE,
			...(synced.syncedAt ? { syncedAt: synced.syncedAt } : {}),
		}
	}
	return { data: builtIn, source: "fallback", stale: false, message: UNAVAILABLE_MESSAGE }
}

/**
 * Choose what to answer when the live catalogue answered.
 *
 * An empty live list is not a success: a provider that lists nothing at the
 * moment must still show the panel something, or the suggested row blinks out
 * and the operator reads it as "this provider has no models".
 */
export function liveAnswer(
	entries: readonly SuggestedModel[],
	synced: { readonly data: readonly SuggestedModel[]; readonly syncedAt?: string } | null,
	builtIn: readonly SuggestedModel[],
): CatalogueAnswer {
	if (entries.length > 0) return { data: entries, source: "live", stale: false }
	return degradedAnswer(synced, builtIn)
}

/**
 * The last-resort answer when the whole request ran out of time.
 *
 * Deliberately touches neither the database nor the network: it is the branch
 * that has already proved one of them can stall.
 */
export function timedOutAnswer(builtIn: readonly SuggestedModel[]): CatalogueAnswer {
	return { data: builtIn, source: "fallback", stale: false, message: UNAVAILABLE_MESSAGE }
}
