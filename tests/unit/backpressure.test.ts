/**
 * Backpressure: the ETA maths, and the gate that enforces the bound.
 *
 * The failures this pins down are the ones that make an ETA lie — a queue depth with no service
 * rate, a saturated gate that holds a caller instead of answering, and a release that lets two
 * requests through one slot.
 */

import { makeAdmissionGate } from "9router-api/application/batches/admission"
import {
	admissionOf,
	positiveInt,
	retryAfterSeconds,
	snapshotOf,
} from "9router-api/domain/backpressure"
import { describe, expect, it } from "vitest"

describe("positiveInt", () => {
	it("keeps a positive integer", () => {
		expect(positiveInt(4, 1)).toBe(4)
		expect(positiveInt(4.9, 1)).toBe(4)
	})

	it("falls back rather than dividing by zero", () => {
		expect(positiveInt(0, 1)).toBe(1)
		expect(positiveInt(-3, 2)).toBe(2)
		expect(positiveInt(Number.NaN, 2)).toBe(2)
		expect(positiveInt(undefined, 2)).toBe(2)
	})
})

describe("retryAfterSeconds", () => {
	it("waits one wave when nothing is queued and one slot is free", () => {
		expect(retryAfterSeconds({ waiting: 0, concurrency: 2, meanServiceMs: 1000 })).toBe(1)
	})

	it("rounds up, so a client that retries on the second does not arrive early", () => {
		// 2 waves × 1100 ms = 2.2 s → 3 s, not 2 s.
		expect(retryAfterSeconds({ waiting: 3, concurrency: 2, meanServiceMs: 1100 })).toBe(3)
	})

	it("answers null before any request has completed", () => {
		// A made-up ETA is worse than a blank one.
		expect(retryAfterSeconds({ waiting: 5, concurrency: 2, meanServiceMs: null })).toBeNull()
	})

	it("treats a zero concurrency as one instead of answering Infinity", () => {
		expect(retryAfterSeconds({ waiting: 0, concurrency: 0, meanServiceMs: 1000 })).toBe(1)
	})
})

describe("admissionOf", () => {
	it("admits while there is a free slot", () => {
		expect(admissionOf({ concurrency: 2, queueCap: 1 }, { inFlight: 1, waiting: 0 })).toBe("admit")
	})

	it("queues when the slots are taken and the queue has room", () => {
		expect(admissionOf({ concurrency: 2, queueCap: 1 }, { inFlight: 2, waiting: 0 })).toBe("queue")
	})

	it("refuses when the queue is full, rather than holding the caller", () => {
		expect(admissionOf({ concurrency: 2, queueCap: 1 }, { inFlight: 2, waiting: 1 })).toBe("refuse")
	})
})

describe("snapshotOf", () => {
	it("reports saturated only when both the slots and the queue are full", () => {
		expect(
			snapshotOf({
				limits: { concurrency: 2, queueCap: 1 },
				inFlight: 2,
				waiting: 1,
				meanServiceMs: 10,
			}).saturated,
		).toBe(true)
		expect(
			snapshotOf({
				limits: { concurrency: 2, queueCap: 1 },
				inFlight: 2,
				waiting: 0,
				meanServiceMs: 10,
			}).saturated,
		).toBe(false)
	})
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("makeAdmissionGate", () => {
	it("never runs more work at once than the bound allows", async () => {
		const gate = makeAdmissionGate({ concurrency: 2, queueCap: 4 })
		let running = 0
		let peak = 0

		await Promise.all(
			Array.from({ length: 6 }, () =>
				gate.run(async () => {
					running += 1
					peak = Math.max(peak, running)
					await sleep(5)
					running -= 1
				}),
			),
		)

		expect(peak).toBeLessThanOrEqual(2)
	})

	it("queues a caller rather than failing it while the queue has room", async () => {
		const gate = makeAdmissionGate({ concurrency: 1, queueCap: 2 })
		const order: number[] = []

		await Promise.all([
			gate.run(async () => {
				await sleep(10)
				order.push(1)
			}),
			gate.run(async () => {
				order.push(2)
			}),
		])

		expect(order).toEqual([1, 2])
	})

	it("refuses with a retry-after once the queue is full", async () => {
		const gate = makeAdmissionGate({ concurrency: 1, queueCap: 0 })
		const slow = gate.run(() => sleep(20))

		await expect(gate.run(async () => undefined)).rejects.toMatchObject({
			code: "UPSTREAM",
			message: expect.stringMatching(/saturated/),
		})

		await slow
	})

	it("reports a mean service time once work has completed", async () => {
		const gate = makeAdmissionGate({ concurrency: 1, queueCap: 1 })

		expect(gate.snapshot().meanServiceMs).toBeNull()
		await gate.run(() => sleep(5))
		expect(gate.snapshot().meanServiceMs).toBeGreaterThanOrEqual(0)
	})

	it("gives the slot back when the work throws, so one failure cannot wedge the gate", async () => {
		const gate = makeAdmissionGate({ concurrency: 1, queueCap: 1 })

		await expect(
			gate.run(async () => {
				throw new Error("boom")
			}),
		).rejects.toThrow("boom")

		await expect(gate.run(async () => "ok")).resolves.toBe("ok")
		expect(gate.snapshot().inFlight).toBe(0)
	})
})
