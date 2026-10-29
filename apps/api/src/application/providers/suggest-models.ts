/**
 * Suggest models for a provider by reading its own catalogue.
 *
 * Called from:
 *   - `apps/api/src/application/use-cases.ts` (`makeSuggestModels`, registered as
 *     `suggestModels`)
 *   - `apps/web/src/app/api/providers/suggested-models/route.ts` via
 *     `getUseCases().suggestModels.run(...)`
 *   - `apps/web/src/app/api/providers/suggested-models/filters.ts` (re-exports the
 *     filter table the host injects)
 *   - `tests/unit/use-case-suggest-models.test.ts`
 *
 * No existing file serves this purpose: `list-free-models.ts` reads the Kilo
 * catalogue through one fixed endpoint, while this reads whichever URL the caller
 * names and needs a per-type filter. The route held fetch, filter choice,
 * stored-copy preference and the whole-request timeout inline.
 *
 * Reads: the stored synced catalogue for the matched registry entry (via the
 * injected `readSynced` port) and the upstream URL it was given. Writes: the
 * stored copy, but only through `refreshSynced`, which is fire-and-forget and
 * cannot fail the request.
 *
 * User instruction, verbatim: "lanjut kenapa malah berhenti".
 */

import { AppError, invalid } from "../../domain/errors.ts"
import {
	type CatalogueAnswer,
	type CatalogueFilters,
	degradedAnswer,
	fallbackFor,
	filterFor,
	liveAnswer,
	type SuggestedModel,
	toCatalogueArray,
} from "../../domain/model-catalogue.ts"

/** The stored copy of a provider's catalogue. */
export interface SyncedCatalogue {
	readonly data: readonly SuggestedModel[]
	readonly syncedAt?: string
}

export interface SuggestModelsDependencies {
	readonly catalogue: CatalogueFilters
	/**
	 * The registry entry whose `modelsFetcher` matches this url and type.
	 *
	 * Only such an entry has a stable id to store a copy under. A url the registry
	 * does not know is still fetched — the caller named it — but nothing is stored.
	 */
	readonly findSyncable: (url: string, type: string) => { readonly id: string } | null
	/** The stored copy for an entry id, or null when none was ever stored. */
	readonly readSynced: (entryId: string) => Promise<SyncedCatalogue | null>
	/** Refresh the stored copy in the background; failure only costs freshness. */
	readonly refreshSynced: (entryId: string) => void
	/** Fetch the upstream catalogue body. Throws on network failure or a bad status. */
	readonly fetchCatalogue: (url: string, type: string) => Promise<unknown>
	/**
	 * Arm the background catalogue syncer on the first request of a process.
	 *
	 * The route is the earliest reliable hook on installs that never open the
	 * provider page, so it arms the syncer once and never again.
	 */
	readonly armSyncer: () => void
	/**
	 * A whole-request ceiling in milliseconds.
	 *
	 * Every await below — the stored-copy read and the upstream fetch — has to
	 * settle inside this window, because on breach the answer is built from the
	 * built-in table with no I/O at all. A stalled backend must not leave the
	 * provider panel blank.
	 */
	readonly timeoutMs: number
}

export function makeSuggestModels({
	catalogue,
	findSyncable,
	readSynced,
	refreshSynced,
	fetchCatalogue,
	armSyncer,
	timeoutMs,
}: SuggestModelsDependencies) {
	let syncerArmed = false

	return {
		/**
		 * The picker entries for one provider catalogue.
		 *
		 * A missing url or type is a caller error and refused; an *unknown* type is
		 * refused too, because filters are not interchangeable and guessing one
		 * would offer entries from the wrong catalogue shape.
		 */
		async run(query: {
			readonly url?: string | null
			readonly type?: string | null
		}): Promise<CatalogueAnswer> {
			if (!syncerArmed) {
				syncerArmed = true
				try {
					armSyncer()
				} catch {
					/* a broken background timer must not fail the request */
				}
			}

			const url = query.url
			const type = query.type
			if (!url || !type) throw invalid("Missing url or type")
			const chosen = filterFor(catalogue, type)
			if (!chosen) throw invalid("Unknown filter type")
			const filter = chosen

			const builtIn = fallbackFor(catalogue, type)
			try {
				return await withTimeout(serve(), timeoutMs, builtIn)
			} catch (error) {
				// The ceiling is the one failure with a safe answer; a refusal the
				// caller caused must still surface as a refusal.
				if (error instanceof AppError) throw error
				return degradedAnswer(await readSyncedSafely(), builtIn)
			}

			async function serve(): Promise<CatalogueAnswer> {
				const entry = findSyncable(url as string, type as string)
				const synced = await readSyncedSafely()
				let body: unknown
				try {
					body = await fetchCatalogue(url as string, type as string)
				} catch {
					return degradedAnswer(synced, builtIn)
				}
				const entries = filter(toCatalogueArray(unwrap(body)))
				if (entry && entries.length > 0) refreshSynced(entry.id)
				return liveAnswer(entries, synced, builtIn)
			}

			async function readSyncedSafely(): Promise<SyncedCatalogue | null> {
				const entry = findSyncable(url as string, type as string)
				if (!entry) return null
				try {
					return await readSynced(entry.id)
				} catch {
					return null
				}
			}
		},
	}
}

/**
 * The list inside an upstream catalogue body.
 *
 * `data` is the OpenAI convention and `models` the open-sse one; a body that is
 * neither is handed over whole so `toCatalogueArray` can wrap it.
 */
function unwrap(body: unknown): unknown {
	if (body !== null && typeof body === "object") {
		const record = body as Record<string, unknown>
		return record.data ?? record.models ?? body
	}
	return body
}

/**
 * Run `work`, or answer from the built-in table when it outlasts the ceiling.
 *
 * The timer is cleared on the way out and is `unref`'d, so a fast request leaves
 * no timer behind holding the process open.
 */
async function withTimeout(
	work: Promise<CatalogueAnswer>,
	timeoutMs: number,
	builtIn: readonly SuggestedModel[],
): Promise<CatalogueAnswer> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const ceiling = new Promise<CatalogueAnswer>((resolve) => {
		timer = setTimeout(() => resolve({ data: builtIn, source: "fallback", stale: false }), timeoutMs)
		if (typeof timer.unref === "function") timer.unref()
	})
	try {
		return await Promise.race([work, ceiling])
	} finally {
		if (timer) clearTimeout(timer)
	}
}
