/**
 * Backpressure: how many requests may be in flight, and how long a caller should wait.
 *
 * The gateway can saturate in one direction only — outbound, at the provider — so the honest
 * control is a bound on concurrent work plus an estimate of the wait. The estimate is the part
 * that goes wrong in every naive implementation:
 *
 * 1. **ETA from a queue length with no service rate is a guess.** Depth alone says nothing about
 *    time; the answer is depth × mean service time ÷ parallelism, and with no completed samples
 *    the mean is unknown — so the answer is `null`, not `0`.
 * 2. **A full queue is not a slow queue.** When the bound is reached the caller must be refused
 *    immediately with the wait it would otherwise face; holding it produces a timeout instead of
 *    an answer.
 * 3. **Zero parallelism divides by zero.** A concurrency of 0 (misconfiguration) is treated as 1,
 *    because the alternative is an infinite ETA on a service that is actually running.
 */

/** How many requests a caller may have in flight, and how many may wait. */
export interface GateLimits {
	readonly concurrency: number
	readonly queueCap: number
}

/** What the gate reports about itself. */
export interface GateSnapshot {
	readonly inFlight: number
	readonly waiting: number
	readonly concurrency: number
	readonly queueCap: number
	/** Mean observed service time in ms, or `null` before any request has finished. */
	readonly meanServiceMs: number | null
	/** Seconds a caller arriving now would wait, or `null` when that cannot be estimated. */
	readonly retryAfterSeconds: number | null
	readonly saturated: boolean
}

/** A positive integer, or the fallback when the value is not one. */
export function positiveInt(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback
	const rounded = Math.trunc(value)
	return rounded > 0 ? rounded : fallback
}

/**
 * Seconds a caller arriving now would wait.
 *
 * `rounds` is how many full waves of queued work sit ahead of it: with a queue of 5 and a
 * parallelism of 2, three waves remain after the current one, and the current one finishes in
 * one service time. Rounded up, because a client that waits 2.2 s and retries at 2 s retries too
 * early and doubles the load.
 */
export function retryAfterSeconds(input: {
	readonly waiting: number
	readonly concurrency: number
	readonly meanServiceMs: number | null
}): number | null {
	if (input.meanServiceMs === null || !Number.isFinite(input.meanServiceMs)) return null
	if (input.meanServiceMs < 0) return null

	const parallelism = positiveInt(input.concurrency, 1)
	const waves = Math.ceil((input.waiting + 1) / parallelism)
	return Math.ceil((waves * input.meanServiceMs) / 1000)
}

/** Whether a caller may proceed, wait, or must be refused. */
export function admissionOf(
	limits: GateLimits,
	snapshot: { readonly inFlight: number; readonly waiting: number },
): "admit" | "queue" | "refuse" {
	const concurrency = positiveInt(limits.concurrency, 1)
	if (snapshot.inFlight < concurrency) return "admit"
	return snapshot.waiting < positiveInt(limits.queueCap, 0) ? "queue" : "refuse"
}

/** The snapshot the gate reports, from its own counters. */
export function snapshotOf(input: {
	readonly limits: GateLimits
	readonly inFlight: number
	readonly waiting: number
	readonly meanServiceMs: number | null
}): GateSnapshot {
	const concurrency = positiveInt(input.limits.concurrency, 1)
	const queueCap = positiveInt(input.limits.queueCap, 0)
	const retryAfter = retryAfterSeconds({
		waiting: input.waiting,
		concurrency,
		meanServiceMs: input.meanServiceMs,
	})

	return {
		inFlight: input.inFlight,
		waiting: input.waiting,
		concurrency,
		queueCap,
		meanServiceMs: input.meanServiceMs,
		retryAfterSeconds: retryAfter,
		saturated: input.inFlight >= concurrency && input.waiting >= queueCap,
	}
}
