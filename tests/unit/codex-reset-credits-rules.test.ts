import { describe, expect, test } from "vitest"
import {
	canRetryAfterExpiry,
	codexEligibility,
	codexProxyOptions,
	consumeOutcome,
	isAuthExpired,
	isCodexRefusal,
} from "../../apps/api/src/domain/codex-reset-credits"

describe("codexEligibility", () => {
	test("an oauth Codex connection is eligible and refreshes first", () => {
		expect(codexEligibility({ provider: "codex", authType: "oauth" })).toEqual({
			ok: true,
			isOAuth: true,
		})
	})

	test("an access-token Codex connection is eligible without a refresh", () => {
		// Refreshing it would report "credential refresh failed" for a connection that needs none.
		expect(codexEligibility({ provider: "codex", authType: "access_token" })).toEqual({
			ok: true,
			isOAuth: false,
		})
	})

	test("a missing connection is 404, not 400", () => {
		const verdict = codexEligibility(null)
		expect(isCodexRefusal(verdict)).toBe(true)
		expect(verdict).toMatchObject({ status: 404 })
	})

	test("another provider is refused with 400", () => {
		const verdict = codexEligibility({ provider: "openai", authType: "oauth" })
		expect(verdict).toMatchObject({ ok: false, status: 400 })
		expect(isCodexRefusal(verdict) && verdict.message).toContain("only available for Codex")
	})

	test("a Codex connection with no usable credential is refused", () => {
		for (const authType of ["apikey", "", undefined, "OAUTH"]) {
			const verdict = codexEligibility({ provider: "codex", authType })
			expect(verdict).toMatchObject({ ok: false, status: 400 })
		}
	})
})

describe("isAuthExpired", () => {
	test("reads the message", () => {
		expect(isAuthExpired({ message: "Token expired" })).toBe(true)
	})

	test("reads the code", () => {
		expect(isAuthExpired({ code: "401" })).toBe(true)
	})

	test("reads a nested detail", () => {
		expect(isAuthExpired({ raw: { detail: "please re-authorize" } })).toBe(true)
	})

	test("reads the shape the upstream most often uses", () => {
		// {error: {code: "401"}} was the case a message-only check missed.
		expect(isAuthExpired({ raw: { error: { code: "401" } } })).toBe(true)
		expect(isAuthExpired({ raw: { error: { message: "Unauthorized" } } })).toBe(true)
	})

	test("an unlimited-credit answer is not expired", () => {
		expect(isAuthExpired({ ok: true, message: "2 credits available" })).toBe(false)
	})

	test("tolerates junk and no argument", () => {
		expect(isAuthExpired()).toBe(false)
		expect(isAuthExpired(null, undefined, 42)).toBe(false)
	})
})

describe("canRetryAfterExpiry", () => {
	test("retries an OAuth connection holding a refresh token", () => {
		expect(canRetryAfterExpiry(true, true, true)).toBe(true)
	})

	test("does not retry without a refresh token", () => {
		// The second call would fail exactly like the first.
		expect(canRetryAfterExpiry(true, false, true)).toBe(false)
	})

	test("does not retry a connection that cannot refresh", () => {
		expect(canRetryAfterExpiry(false, true, true)).toBe(false)
	})

	test("does not retry when nothing was reported expired", () => {
		expect(canRetryAfterExpiry(true, true, false)).toBe(false)
	})
})

describe("consumeOutcome", () => {
	test("a successful consume is 200 and echoes the request id", () => {
		const out = consumeOutcome(
			{ ok: true, code: "ok", windowsReset: 2, raw: { credit: { id: "c1" } } },
			"req-1",
		)
		expect(out.status).toBe(200)
		expect(out.body.reset).toBe(true)
		expect(out.body.redeemRequestId).toBe("req-1")
		expect(out.body.credit).toEqual({ id: "c1" })
	})

	test("a successful consume with no credit detail reports null, not undefined", () => {
		expect(consumeOutcome({ ok: true }, "req-2").body.credit).toBe(null)
	})

	test("no credit is 409, not an error", () => {
		const out = consumeOutcome({ noCredit: true, windowsReset: 0 }, "req-3")
		expect(out.status).toBe(409)
		expect(out.body.code).toBe("no_credit")
		expect(out.body.reset).toBe(false)
	})

	test("a 4xx upstream status passes through", () => {
		expect(consumeOutcome({ status: 429, message: "slow down" }, "r").status).toBe(429)
		expect(consumeOutcome({ status: 400, message: "bad" }, "r").status).toBe(400)
	})

	test("a 5xx or missing status becomes 502, not 500", () => {
		// This service could not get an answer; it did not break.
		expect(consumeOutcome({ status: 500, message: "oops" }, "r").status).toBe(502)
		expect(consumeOutcome({ status: undefined }, "r").status).toBe(502)
		expect(consumeOutcome({}, "r").status).toBe(502)
	})

	test("an unexplained failure is labelled, not left blank", () => {
		const out = consumeOutcome({ status: 500 }, "r")
		expect(out.body.code).toBe("unknown_response")
		expect(String(out.body.message)).toContain("unexpected response")
	})
})

describe("codexProxyOptions", () => {
	test("pins strictProxy false so a dead proxy cannot fail a healthy account", () => {
		expect(codexProxyOptions({}).strictProxy).toBe(false)
	})

	test("only a literal true enables the connection proxy", () => {
		expect(codexProxyOptions({ connectionProxyEnabled: true }).connectionProxyEnabled).toBe(true)
		expect(codexProxyOptions({ connectionProxyEnabled: "true" }).connectionProxyEnabled).toBe(false)
	})

	test("missing fields become empty strings, not null", () => {
		expect(codexProxyOptions(null)).toEqual({
			connectionProxyEnabled: false,
			connectionProxyUrl: "",
			connectionNoProxy: "",
			vercelRelayUrl: "",
			strictProxy: false,
		})
	})
})
