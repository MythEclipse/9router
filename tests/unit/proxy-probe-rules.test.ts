import { describe, expect, test } from "vitest"
import {
	proxyProbeAnswer,
	proxyProbeErrorMessage,
	proxyProbeFailureStatus,
} from "../../apps/api/src/domain/proxy-probe"

describe("proxyProbeFailureStatus", () => {
	test("the probe's own status is the answer, including 407", () => {
		// A proxy demanding auth is a precise diagnosis; a 500 would send the operator to the wrong box.
		expect(proxyProbeFailureStatus({ ok: false, status: 407 })).toBe(407)
		expect(proxyProbeFailureStatus({ ok: false, status: 403 })).toBe(403)
		expect(proxyProbeFailureStatus({ ok: false, status: 502 })).toBe(502)
	})

	test("a probe that reported no status at all is a 500", () => {
		expect(proxyProbeFailureStatus({ ok: false })).toBe(500)
		expect(proxyProbeFailureStatus(null)).toBe(500)
		expect(proxyProbeFailureStatus(undefined)).toBe(500)
	})

	test("a non-numeric status is not trusted as a status", () => {
		expect(proxyProbeFailureStatus({ status: "407" } as never)).toBe(500)
	})
})

describe("proxyProbeAnswer", () => {
	test("success passes the probe's fields through unchanged", () => {
		const result = { ok: true, status: 200, statusText: "OK", url: "https://x", elapsedMs: 12 }
		expect(proxyProbeAnswer(result)).toEqual({ status: 200, body: result })
	})

	test("failure reports ok:false and keeps the probe's status", () => {
		expect(proxyProbeAnswer({ ok: false, status: 407, error: "proxy auth required" })).toEqual({
			status: 407,
			body: { ok: false, error: "proxy auth required" },
		})
	})

	test("a failure with no message still says something", () => {
		expect(proxyProbeAnswer({ ok: false, status: 400 }).body.error).toBe("Proxy test failed")
	})

	test("a missing result is a 500 with a message, never a 200", () => {
		expect(proxyProbeAnswer(null)).toEqual({
			status: 500,
			body: { ok: false, error: "Proxy test failed" },
		})
	})
})

describe("proxyProbeErrorMessage", () => {
	test("an abort is a timeout, not a crash", () => {
		// This is the probe's own AbortSignal firing; "The operation was aborted" tells nobody anything.
		const abort = new Error("The operation was aborted")
		abort.name = "AbortError"
		expect(proxyProbeErrorMessage(abort)).toBe("Proxy test timed out")
	})

	test("other errors keep their message", () => {
		expect(proxyProbeErrorMessage(new Error("ECONNREFUSED"))).toBe("ECONNREFUSED")
	})

	test("a non-Error is stringified rather than rendered as undefined", () => {
		expect(proxyProbeErrorMessage("boom")).toBe("boom")
		expect(proxyProbeErrorMessage(null)).toBe("null")
	})
})
