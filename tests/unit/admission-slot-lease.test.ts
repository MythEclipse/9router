/**
 * Regression test: an admission slot must always come back.
 *
 * The gate on `/v1` holds one slot per request for as long as the answer streams, and the
 * release used to depend entirely on the wrapped body's `flush`/`cancel` hook. A client that
 * disconnected while the answer was being built fired neither, so the slot was gone for the
 * life of the process: eight of those left the gateway answering `429` with
 * `Retry-After: 120` to every request, including ones with an invalid key, for three hours —
 * with no request reaching a handler and nothing in the log to say why.
 *
 * These cases pin the three exits that make the return unconditional.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { holdSlot } from "../../apps/web/src/sse/middleware/slotLease"

afterEach(() => {
	vi.useRealTimers()
})

describe("holdSlot", () => {
	it("hands the slot back when the body ends", () => {
		const release = vi.fn()
		const end = holdSlot(release, { maxHoldMs: 1000 })

		end()

		expect(release).toHaveBeenCalledTimes(1)
	})

	it("hands it back when the client hangs up", () => {
		const release = vi.fn()
		const controller = new AbortController()
		holdSlot(release, { maxHoldMs: 1000, signal: controller.signal })

		controller.abort()

		expect(release).toHaveBeenCalledTimes(1)
	})

	it("hands it back at the deadline when neither hook fires", () => {
		vi.useFakeTimers()
		const release = vi.fn()
		const overrun = vi.fn()
		holdSlot(release, { maxHoldMs: 5000, onOverrun: overrun })

		vi.advanceTimersByTime(4999)
		expect(release).not.toHaveBeenCalled()

		vi.advanceTimersByTime(1)
		expect(release).toHaveBeenCalledTimes(1)
		expect(overrun).toHaveBeenCalledTimes(1)
		expect(overrun.mock.calls[0][0]).toBe(5000)
	})

	it("releases once even when the hooks and the deadline all fire", () => {
		vi.useFakeTimers()
		const release = vi.fn()
		const controller = new AbortController()
		const end = holdSlot(release, { maxHoldMs: 1000, signal: controller.signal })

		end()
		controller.abort()
		vi.advanceTimersByTime(5000)

		expect(release).toHaveBeenCalledTimes(1)
	})

	it("hands it back immediately when the client left before the slot was granted", () => {
		const release = vi.fn()
		const controller = new AbortController()
		controller.abort()

		holdSlot(release, { maxHoldMs: 1000, signal: controller.signal })

		expect(release).toHaveBeenCalledTimes(1)
	})

	it("does not report an overrun for a hold that ended normally", () => {
		const release = vi.fn()
		const overrun = vi.fn()
		const end = holdSlot(release, { maxHoldMs: 1000, onOverrun: overrun })

		end()

		expect(overrun).not.toHaveBeenCalled()
	})
})
