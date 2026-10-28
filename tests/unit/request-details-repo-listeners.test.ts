// Regression guard: requestDetailsRepo must not accumulate process listeners.
//
// The module registers shutdown hooks (beforeExit/SIGINT/SIGTERM/exit) at import
// time. It originally did `process.off(handler)` then `process.on(handler)`, which
// looks idempotent but is not: every re-evaluation of the module (vi.resetModules()
// in tests, hot reload, a second import path) creates a *distinct* handler closure,
// so `off` could only remove its own and every earlier instance stayed attached
// forever. The suite drifted past Node's 10-listener limit and emitted
// MaxListenersExceededWarning on all four events.
//
// The failure mode this guards is silent: the warning does not fail a test, so
// only an explicit listener-count assertion keeps it from creeping back.
import { afterEach, describe, expect, it, vi } from "vitest"

const EVENTS = ["beforeExit", "SIGINT", "SIGTERM", "exit"] as const

afterEach(() => {
	vi.resetModules()
})

describe("requestDetailsRepo shutdown hooks", () => {
	it("adds one listener per event even when re-evaluated many times", async () => {
		const before = Object.fromEntries(EVENTS.map((e) => [e, process.listenerCount(e)])) as Record<
			(typeof EVENTS)[number],
			number
		>

		for (let i = 0; i < 15; i++) {
			vi.resetModules()
			await import("../../apps/web/src/lib/db/repos/requestDetailsRepo")
		}

		for (const event of EVENTS) {
			const added = process.listenerCount(event) - before[event]
			// One dispatcher per event for the whole process, regardless of how many
			// module instances came and went.
			expect(added, `${event} listener growth`).toBeLessThanOrEqual(1)
		}
	})

	it("keeps the process listener count well under Node's warning threshold", async () => {
		for (let i = 0; i < 15; i++) {
			vi.resetModules()
			await import("../../apps/web/src/lib/db/repos/requestDetailsRepo")
		}

		for (const event of EVENTS) {
			// Node warns at 11+ listeners on one event.
			expect(process.listenerCount(event), `${event} total`).toBeLessThan(11)
		}
	})
})
