/**
 * Every path that has to give an admission slot back.
 *
 * A streamed answer holds its slot until the body ends, so the slot normally returns from
 * the stream's own `flush` or `cancel` hook. Both are missed when a client disconnects and
 * the runtime drops the body without cancelling it — and then nothing returns the slot at
 * all. Eight such aborts leave the gate refusing every later request with a 429 that no
 * traffic can clear, because the traffic that caused it has already left and the counter
 * only ever goes down on a release that never comes.
 *
 * So a hold carries three exits, and the first one to fire wins: the caller's own release,
 * the request aborting (an aborted client cannot be served, so its slot is not needed), and
 * a deadline that exists purely to guarantee the slot comes back when both hooks are lost.
 */

/** Why a hold ended. Only `deadline` is an anomaly worth logging. */
export type SlotReleaseReason = "hook" | "abort" | "deadline"

export interface SlotHoldOptions {
	/** The request's own signal. An aborted request gives its slot back immediately. */
	readonly signal?: AbortSignal
	/** Upper bound on one hold, in ms. Reaching it releases the slot. */
	readonly maxHoldMs: number
	/** Called once when the deadline — not a hook — released the slot. */
	readonly onOverrun?: (heldMs: number) => void
}

/**
 * Wrap `releaseSlot` so the slot returns exactly once, from whichever exit gets there first.
 *
 * @returns the release to call when the body ends
 */
export function holdSlot(releaseSlot: () => void, options: SlotHoldOptions): () => void {
	const { signal, maxHoldMs, onOverrun } = options
	const startedAt = Date.now()
	let held = true

	const give = (reason: SlotReleaseReason): void => {
		if (!held) return
		held = false
		clearTimeout(deadline)
		signal?.removeEventListener("abort", onAbort)
		releaseSlot()
		if (reason === "deadline") onOverrun?.(Date.now() - startedAt)
	}

	const onAbort = () => give("abort")
	const deadline = setTimeout(() => give("deadline"), maxHoldMs)
	// A pending deadline must never be the reason this process stays alive.
	if (typeof deadline === "object" && typeof deadline.unref === "function") deadline.unref()

	// An abort that landed before the slot was granted still means nobody is waiting for
	// the answer, so the slot is handed straight back rather than held for a dead caller.
	if (signal?.aborted) give("abort")
	else signal?.addEventListener("abort", onAbort, { once: true })

	return () => give("hook")
}
