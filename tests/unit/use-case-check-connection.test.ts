// Tests for apps/api/src/application/providers/check-connection.ts — the short
// verdict the dashboard's test button shows, and the 404 it draws.
//
// No existing test file covers this use-case; the route mapped
// `error === "Connection not found"` to a 404 inline in
// apps/web/src/app/api/providers/[id]/test/route.ts. (opencode-test-button.test.ts
// covers the tester itself, testUtils.ts, not this translation.)
//
// User instruction, verbatim: "lanjut kenapa malah berhenti".

import { describe, expect, it, vi } from "vitest"
import {
	CONNECTION_NOT_FOUND,
	makeCheckConnection,
} from "../../apps/api/src/application/providers/check-connection.ts"
import type { ProbeOutcome } from "../../apps/api/src/domain/batch-result.ts"

const harness = (outcome: ProbeOutcome) =>
	makeCheckConnection({ probe: vi.fn(async () => outcome) })

describe("verdict", () => {
	it("passes a valid probe through", async () => {
		const verdict = await harness({ valid: true, latencyMs: 12 }).run("c1")
		expect(verdict).toEqual({ valid: true, error: null, refreshed: false })
	})

	it("passes the upstream error through instead of hiding it", async () => {
		// The dashboard shows the provider's own message; a generic "failed" would
		// throw away the only clue the operator has.
		const verdict = await harness({ valid: false, error: "HTTP 502: bad gateway" }).run("c1")
		expect(verdict.valid).toBe(false)
		expect(verdict.error).toBe("HTTP 502: bad gateway")
	})

	it("reports a refreshed flag only when the probe says so", async () => {
		expect((await harness({ valid: true, refreshed: true }).run("c1")).refreshed).toBe(true)
		expect((await harness({ valid: true }).run("c1")).refreshed).toBe(false)
	})
})

describe("the missing-connection case", () => {
	it("raises a 404 rather than reporting a failed probe", async () => {
		// The panel offers "test again" on a failure and refreshes the list on a
		// 404, so the two must stay distinguishable.
		await expect(
			harness({ valid: false, error: CONNECTION_NOT_FOUND }).run("ghost"),
		).rejects.toMatchObject({ code: "NOT_FOUND" })
	})

	it("does not treat a provider's own wording of the same message as a 404", async () => {
		// Only the tester's exact string means "no such row"; an upstream body that
		// happens to say "Connection not found" is still a failed probe.
		const verdict = await harness({ valid: false, error: "Connection not found (upstream)" }).run(
			"c1",
		)
		expect(verdict.valid).toBe(false)
	})
})
