// Tests for apps/api/src/domain/batch-result.ts — how a probe outcome becomes a
// batch row, and how the rows are counted.
//
// No existing test file covers this: the row shape was duplicated inline in the
// success and catch branches of apps/web/src/app/api/providers/test-batch/route.ts.
//
// User instruction, verbatim: "lanjut kenapa malah berhenti".

import { describe, expect, it } from "vitest"
import {
	connectionLabel,
	outcomeFromError,
	type ProbeOutcome,
	summarise,
	toBatchResult,
} from "../../apps/api/src/domain/batch-result.ts"

const conn = { id: "c1", provider: "kiro", authType: "oauth" }
const now = () => "2026-10-29T00:00:00.000Z"

describe("connectionLabel", () => {
	it("prefers the operator's name", () => {
		expect(connectionLabel({ ...conn, name: "work", email: "a@b.c" })).toBe("work")
	})

	it("falls back to the email an OAuth account carries", () => {
		expect(connectionLabel({ ...conn, email: "a@b.c" })).toBe("a@b.c")
	})

	it("falls back to the provider id so a row is never blank", () => {
		expect(connectionLabel(conn)).toBe("kiro")
	})

	it("treats an empty name as absent", () => {
		expect(connectionLabel({ ...conn, name: "", email: "a@b.c" })).toBe("a@b.c")
	})
})

describe("outcomeFromError", () => {
	it("reports a throw as a network failure with the thrown message", () => {
		const outcome = outcomeFromError(new Error("ECONNREFUSED"))
		expect(outcome.valid).toBe(false)
		expect(outcome.error).toBe("ECONNREFUSED")
		expect(outcome.latencyMs).toBe(0)
		expect(outcome.statusCode).toBeNull()
		const diagnosis = outcome.diagnosis as Record<string, unknown>
		expect(diagnosis.type).toBe("network_error")
		expect(diagnosis.source).toBe("local")
		expect(diagnosis.code).toBeNull()
		expect(diagnosis.message).toBe("ECONNREFUSED")
	})

	it("handles a thrown non-Error without losing it", () => {
		expect(outcomeFromError("boom").error).toBe("boom")
	})
})

describe("toBatchResult", () => {
	it("carries a successful probe through", () => {
		const outcome: ProbeOutcome = {
			valid: true,
			latencyMs: 42,
			statusCode: 200,
			diagnosis: "fine",
			testedAt: "2026-10-28T00:00:00.000Z",
		}
		expect(toBatchResult(conn, outcome, "oauth", now)).toEqual({
			provider: "kiro",
			connectionId: "c1",
			connectionName: "kiro",
			authType: "oauth",
			valid: true,
			latencyMs: 42,
			error: null,
			diagnosis: "fine",
			statusCode: 200,
			testedAt: "2026-10-28T00:00:00.000Z",
		})
	})

	it("substitutes zeros and the clock for what the probe omitted", () => {
		const row = toBatchResult(conn, { valid: false, error: "HTTP 401" }, "oauth", now)
		expect(row.latencyMs).toBe(0)
		expect(row.statusCode).toBeNull()
		expect(row.testedAt).toBe(now())
	})

	it("keeps the probed diagnosis shape unchanged", () => {
		// The route's catch branch reported an object here while its success branch
		// passed a string through, so one response carried two shapes of the field.
		const diagnosis = { type: "network_error", source: "local", code: null, message: "x" }
		const row = toBatchResult(conn, { valid: false, diagnosis }, "oauth", now)
		expect(row.diagnosis).toEqual(diagnosis)
	})

	it("prefers the connection's own authType over the group", () => {
		const row = toBatchResult(conn, { valid: true }, "free", now)
		expect(row.authType).toBe("oauth")
	})

	it("falls back to the group when the connection carries no authType", () => {
		const bare = { id: "c2", provider: "kiro" }
		expect(toBatchResult(bare, { valid: true }, "free", now).authType).toBe("free")
	})
})

describe("summarise", () => {
	it("counts passed and failed", () => {
		const rows = [
			toBatchResult(conn, { valid: true }, "oauth", now),
			toBatchResult(conn, { valid: false }, "oauth", now),
			toBatchResult(conn, { valid: true }, "oauth", now),
		]
		expect(summarise(rows)).toEqual({ total: 3, passed: 2, failed: 1 })
	})

	it("counts an empty run as 0/0/0 rather than omitting it", () => {
		expect(summarise([])).toEqual({ total: 0, passed: 0, failed: 0 })
	})
})
