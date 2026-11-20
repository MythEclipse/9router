/**
 * A slow first attempt must not consume the whole account rotation.
 *
 * The fallback budget is a wall-clock deadline (25s generic, 45s opencode) that
 * is seeded once per request. One attempt can outlast it on its own: antigravity
 * answers a spent quota with 429 after ~47s, so the very first failure landed
 * past the deadline and `budgetSpent()` was already true. The loop then returned
 * that error without trying the second account — while still logging
 * "→ NEXT PROXY/ACCOUNT", which made a skipped rotation read like a performed
 * one. The user-visible symptom was a combo member failing after one account
 * with "fallback budget spent … after 1 accounts".
 *
 * The fix counts started attempts and refuses to let the deadline stop the loop
 * before a rotation has actually been given a chance.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FallbackState } from "../../apps/web/src/sse/handlers/chat/fallbackState.js"

const responses = {
	errorResponse: (status: number, body: string) => new Response(body, { status }),
} as any

function makeState(provider = "antigravity") {
	return new FallbackState({
		// A real Request: `FallbackState` keys its per-request proxy state off it
		// with a WeakMap, and the type is `Request | null`.
		request: new Request("http://localhost/v1/chat/completions"),
		provider,
		model: "gemini-3.8-flash-low",
		hideError: false,
		responses,
	})
}

describe("FallbackState budget: a slow first attempt cannot skip the rotation", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("does not stop before any attempt has failed", () => {
		// No failure recorded yet: a slow start is not an exhausted rotation.
		const state = makeState()
		vi.advanceTimersByTime(60_000)
		expect(state.shouldStopForBudget()).toBe(false)
	})

	it("gives the rotation one chance even after a 47s first attempt", () => {
		// This is the reported case: 46748ms on account 1 against a 25s budget.
		const state = makeState()
		state.noteAttemptStarted() // account 1 begins
		vi.advanceTimersByTime(46_748) // upstream finally answers 429
		state.recordFailure({ connectionId: "acc-1", status: 429, error: "RESOURCE_EXHAUSTED" })

		expect(state.budgetSpent()).toBe(true) // the clock is indeed gone…
		expect(state.shouldStopForBudget()).toBe(false) // …but account 2 must still run
	})

	it("stops once the rotation itself has been spent", () => {
		const state = makeState()
		state.noteAttemptStarted() // account 1
		vi.advanceTimersByTime(46_748)
		state.recordFailure({ connectionId: "acc-1", status: 429, error: "RESOURCE_EXHAUSTED" })
		state.noteAttemptStarted() // account 2
		state.recordFailure({ connectionId: "acc-2", status: 429, error: "RESOURCE_EXHAUSTED" })

		// Two real attempts and the deadline gone: this is a spent rotation, and
		// the loop is allowed to hand back the last error.
		expect(state.shouldStopForBudget()).toBe(true)
	})

	it("keeps bounding a provider whose accounts all fail fast", () => {
		// The deadline must still cap the loop: many dead credentials cannot hold
		// the request open indefinitely. Attempts past the first two stop on time.
		const state = makeState()
		for (let i = 0; i < 2; i++) {
			state.noteAttemptStarted()
			state.recordFailure({ connectionId: `acc-${i}`, status: 429, error: "429" })
		}
		expect(state.shouldStopForBudget()).toBe(false) // still inside the budget
		vi.advanceTimersByTime(26_000)
		expect(state.shouldStopForBudget()).toBe(true) // deadline now governs
	})

	it("counts attempts so the log can report what actually ran", () => {
		const state = makeState()
		expect(state.attemptCount).toBe(0)
		state.noteAttemptStarted()
		expect(state.attemptCount).toBe(1)
		state.noteAttemptStarted()
		expect(state.attemptCount).toBe(2)
	})

	it("applies the same guarantee to opencode's longer budget", () => {
		const state = makeState("opencode")
		state.noteAttemptStarted()
		vi.advanceTimersByTime(50_000) // past 45s
		state.recordFailure({ connectionId: "acc-1", status: 429, error: "quota" })
		expect(state.shouldStopForBudget()).toBe(false)
	})
})
