/**
 * The admission gate: a bound on concurrent outbound work, with a queue and a measured ETA.
 *
 * Used by the batch runner, which is the one caller in this process that can put many requests on
 * the provider at once. The gate is deliberately *in-process*: a single gateway instance has one
 * event loop and one connection budget, and a shared queue across instances would need a store
 * this app does not have.
 *
 * The service time is a running mean of the last `SAMPLE_WINDOW` completed requests. A mean, not
 * a max, because one slow request should raise the estimate without pinning it to its worst case
 * for the rest of the day.
 */
import {
	admissionOf,
	type GateLimits,
	type GateSnapshot,
	positiveInt,
	snapshotOf,
} from "../../domain/backpressure.ts"
import { AppError } from "../../domain/errors.ts"

const SAMPLE_WINDOW = 50

export interface AdmissionGate {
	/** Run `work` under the gate, waiting for a slot when one is not free. */
	readonly run: <T>(work: () => Promise<T>) => Promise<T>
	/**
	 * Take a slot and answer the function that gives it back.
	 *
	 * `run` cannot serve a streamed response: the promise settles when the `Response` object is
	 * built, while the work the slot is protecting continues until the last chunk has been
	 * flushed. A caller holding a stream therefore acquires, returns the response, and releases
	 * from the stream's own `flush`/`cancel` hooks. Releasing twice is safe — the slot is only
	 * handed on once — because a cancelled stream can fire both hooks.
	 */
	readonly acquire: () => Promise<() => void>
	readonly snapshot: () => GateSnapshot
}

export function makeAdmissionGate(limits: GateLimits): AdmissionGate {
	const concurrency = positiveInt(limits.concurrency, 1)
	const queueCap = positiveInt(limits.queueCap, 0)

	let inFlight = 0
	const waiting: Array<() => void> = []
	const samples: number[] = []

	const meanServiceMs = (): number | null =>
		samples.length === 0 ? null : samples.reduce((sum, value) => sum + value, 0) / samples.length

	const snapshot = () =>
		snapshotOf({ limits, inFlight, waiting: waiting.length, meanServiceMs: meanServiceMs() })

	/** Hand the slot to the next waiter, or give it back. */
	function release(startedAt: number): void {
		samples.push(Date.now() - startedAt)
		if (samples.length > SAMPLE_WINDOW) samples.shift()

		const next = waiting.shift()
		if (next) {
			// The slot moves to the waiter without ever being counted as free, so a burst cannot
			// slip past the bound between a release and the next acquire.
			next()
			return
		}
		inFlight -= 1
	}

	/** Take a slot, or throw when the queue is full. */
	async function acquire(): Promise<() => void> {
		const verdict = admissionOf({ concurrency, queueCap }, { inFlight, waiting: waiting.length })

		if (verdict === "refuse") {
			const current = snapshot()
			throw new AppError("UPSTREAM", "The gateway is saturated; retry later", {
				data: { retryAfterSeconds: current.retryAfterSeconds ?? 1, ...current },
			})
		}

		if (verdict === "queue") {
			await new Promise<void>((resolve) => waiting.push(resolve))
		} else {
			inFlight += 1
		}

		const startedAt = Date.now()
		let released = false
		return () => {
			// A stream fires `flush` and may also fire `cancel`; the slot is handed on once.
			if (released) return
			released = true
			release(startedAt)
		}
	}

	async function run<T>(work: () => Promise<T>): Promise<T> {
		const releaseSlot = await acquire()
		try {
			return await work()
		} finally {
			releaseSlot()
		}
	}

	return { acquire, run, snapshot }
}
