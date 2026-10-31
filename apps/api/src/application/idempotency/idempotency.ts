/**
 * The idempotency use-case: claim a key, then record what it answered.
 *
 * The store is a port because the claim has to be atomic — two requests arriving together must
 * not both win — and atomicity is the database's property, not this module's. Everything the
 * rules decide lives in `domain/idempotency.ts`; this file only sequences the calls.
 *
 * The sequence is claim → run → complete, and each step has one failure mode worth naming:
 *
 *  - **A claim that loses** reports what the winner is doing: `replay` carries the stored
 *    answer, `in_progress` means the caller should retry shortly, `conflict` means the body
 *    changed under the same key.
 *  - **A run that throws leaves the claim behind** unless it is released, and the key would
 *    then be stuck "in progress" until it expired — a retry that can never succeed. So a
 *    thrown run always releases the claim.
 *  - **A response that cannot be replayed** (a stream, a 5xx) is stored as a release rather
 *    than as an answer, so the next retry re-runs instead of replaying a fragment.
 */
import {
	IDEMPOTENCY_TTL_MS,
	type IdempotencyRecord,
	type IdempotencyVerdict,
	idempotencyVerdict,
	isReplayableResponse,
} from "../../domain/idempotency.ts"

/** The stored claim, as the repository returns it. */
export interface IdempotencyStore {
	/** Read the current record for a key, or `null`. */
	read(key: string): Promise<IdempotencyRecord | null>
	/**
	 * Claim a key. Answers `true` when this caller created the claim, `false` when someone
	 * else holds it — the only operation that has to be atomic.
	 */
	claim(entry: {
		readonly key: string
		readonly fingerprint: string
		readonly expiresAt: number
	}): Promise<boolean>
	/** Record the answer for a claimed key. */
	complete(
		key: string,
		entry: {
			readonly status: number
			readonly contentType: string | null
			readonly body: string
		},
	): Promise<void>
	/** Drop a claim without an answer, so a retry may run. */
	release(key: string): Promise<void>
	/** Delete expired rows. */
	prune(now: number): Promise<number>
}

export interface IdempotencyClaim {
	readonly verdict: IdempotencyVerdict
	/** Present on `replay`: the response to hand back unchanged. */
	readonly replay?: {
		readonly status: number
		readonly contentType: string | null
		readonly body: string
	}
}

export interface IdempotencyUseCase {
	/** Claim a key for this request, or report why it cannot run. */
	readonly begin: (key: string, fingerprint: string) => Promise<IdempotencyClaim>
	/** Store the answer for a claimed key (or release it when it is not replayable). */
	readonly finish: (
		key: string,
		response: { readonly status: number; readonly contentType: string | null; readonly body: string },
	) => Promise<void>
	/** Release a claim whose request failed before producing an answer. */
	readonly abandon: (key: string) => Promise<void>
}

export function makeIdempotency(deps: {
	readonly store: IdempotencyStore
	/** Injected so the tests can move the clock. */
	readonly now?: () => number
}): IdempotencyUseCase {
	const now = deps.now ?? (() => Date.now())

	return {
		async begin(key, fingerprint) {
			const at = now()

			// Two passes at most: the second exists only for the case where the record read on
			// the first pass was already expired, which the claim refuses because the row is
			// still there. Without the retry, an expired key would answer "in progress" forever
			// — a retry that can never succeed and an error that blames the caller.
			for (let attempt = 0; attempt < 2; attempt++) {
				const existing = await deps.store.read(key)
				const verdict = idempotencyVerdict(existing, fingerprint, at)

				if (verdict === "replay" && existing) {
					return {
						verdict,
						replay: {
							status: existing.status ?? 200,
							contentType: existing.contentType,
							body: existing.body ?? "",
						},
					}
				}
				if (verdict === "conflict" || verdict === "in_progress") return { verdict }

				// `fresh` with a row present means the row has expired. It has to go before the
				// claim, or the insert is refused by something that no longer means anything.
				if (existing) {
					await deps.store.release(key)
					continue
				}

				const claimed = await deps.store.claim({
					key,
					fingerprint,
					expiresAt: at + IDEMPOTENCY_TTL_MS,
				})
				if (claimed) return { verdict: "fresh" }

				// Lost the race between the read and the insert: the next pass reports what the
				// winner is doing instead of running a second execution.
			}

			const raced = await deps.store.read(key)
			const after = idempotencyVerdict(raced, fingerprint, at)
			if (after === "replay" && raced) {
				return {
					verdict: after,
					replay: {
						status: raced.status ?? 200,
						contentType: raced.contentType,
						body: raced.body ?? "",
					},
				}
			}
			return { verdict: after === "fresh" ? "in_progress" : after }
		},

		async finish(key, response) {
			if (!isReplayableResponse(response)) {
				// A stream or a 5xx must not become the answer for the next 24 hours.
				await deps.store.release(key)
				return
			}
			await deps.store.complete(key, response)
		},

		async abandon(key) {
			await deps.store.release(key)
		},
	}
}
