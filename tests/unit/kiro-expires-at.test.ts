/**
 * When a refreshed Kiro credential expires.
 *
 * `kiro-external-idp.test.ts` covers the refresh request and asserts the raw `expiresIn`, but never
 * `expiresAt` — the computed instant. That is the value deciding when a connection is treated as
 * stale, so a sign error or a seconds/milliseconds mix-up stays invisible until a token either dies
 * an hour early or is still trusted after it stopped working.
 *
 * `now` is passed in, so every expectation below is exact rather than "within a second".
 */

import { resolveExpiresAt } from "9router-api/domain/kiro-external-idp"
import { describe, expect, it } from "vitest"

/** A fixed instant, so a failure is a wrong answer rather than a slow clock. */
const NOW = Date.UTC(2026, 9, 30, 12, 0, 0)

function jwt(payload: Record<string, unknown>): string {
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
	return `${encode({ alg: "none" })}.${encode(payload)}.`
}

describe("an expiry the provider stated is taken as-is", () => {
	it("uses `expires_at` when it parses", () => {
		const stated = "2026-11-01T00:00:00.000Z"
		expect(resolveExpiresAt({ expires_at: stated }, NOW)).toBe(stated)
	})

	it("accepts the camelCase spelling the CLI writes", () => {
		const stated = "2026-11-02T03:04:05.000Z"
		expect(resolveExpiresAt({ expiresAt: stated }, NOW)).toBe(stated)
	})

	it("prefers a stated expiry over a duration, because it is the provider's own answer", () => {
		const stated = "2026-11-01T00:00:00.000Z"
		expect(resolveExpiresAt({ expired: stated, expires_in: 9999 }, NOW)).toBe(stated)
	})

	it("ignores a stated expiry that does not parse and falls through", () => {
		// "not-a-date" is what a half-written config looks like; it must not become Invalid Date.
		expect(resolveExpiresAt({ expired: "not-a-date", expires_in: 60 }, NOW)).toBe(
			new Date(NOW + 60_000).toISOString(),
		)
	})
})

describe("a duration is measured from the injected clock", () => {
	it("adds the seconds to now", () => {
		expect(resolveExpiresAt({ expires_in: 3600 }, NOW)).toBe(new Date(NOW + 3_600_000).toISOString())
	})

	it("reads the duration as seconds, not milliseconds", () => {
		// A 1000x error here is the difference between an hour and six weeks.
		expect(resolveExpiresAt({ expires_in: 1 }, NOW)).toBe(new Date(NOW + 1000).toISOString())
	})

	it("accepts a numeric string, which is what a form post sends", () => {
		expect(resolveExpiresAt({ expires_in: "120" }, NOW)).toBe(new Date(NOW + 120_000).toISOString())
	})

	it("rejects zero and negatives rather than trusting them", () => {
		for (const expires_in of [0, -1, -3600]) {
			const answer = resolveExpiresAt({ expires_in, access_token: jwt({ exp: 1 }) }, NOW)
			// Falls through to the JWT claim, not to "now" or "the past".
			expect(answer).toBe(new Date(1000).toISOString())
		}
	})
})

describe("the token's own claim is the last real source", () => {
	it("uses `exp` seconds from the JWT", () => {
		const exp = Math.floor(NOW / 1000) + 7200
		expect(resolveExpiresAt({ access_token: jwt({ exp }) }, NOW)).toBe(
			new Date(exp * 1000).toISOString(),
		)
	})

	it("ignores a token that is not a readable JWT", () => {
		// Falls through to the default rather than throwing: an opaque token still works.
		expect(resolveExpiresAt({ access_token: "opaque-token" }, NOW)).toBe(
			new Date(NOW + 3_600_000).toISOString(),
		)
	})
})

describe("with nothing stated, an hour is assumed rather than refusing the credential", () => {
	it("defaults to one hour from now", () => {
		expect(resolveExpiresAt({}, NOW)).toBe(new Date(NOW + 3_600_000).toISOString())
	})

	it("defaults even when a token is present but carries no exp", () => {
		expect(resolveExpiresAt({ access_token: jwt({ sub: "x" }) }, NOW)).toBe(
			new Date(NOW + 3_600_000).toISOString(),
		)
	})
})

describe("the result is always a usable ISO instant", () => {
	it("never produces an invalid date for any input shape", () => {
		const inputs = [
			{},
			{ expires_in: 0 },
			{ expires_in: "abc" },
			{ expired: null, expires_in: null },
			{ access_token: "x" },
			{ expires_at: "" },
		]
		for (const input of inputs) {
			const answer = resolveExpiresAt(input, NOW)
			expect(Number.isNaN(new Date(answer).getTime())).toBe(false)
		}
	})
})
