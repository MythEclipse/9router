import { describe, expect, it } from "vitest"

import { mayStopFromDashboard, mayStopFromHook } from "../../apps/api/src/domain/shutdown-gate.ts"

describe("mayStopFromDashboard", () => {
	it("allows a password session", () => {
		expect(mayStopFromDashboard({ role: "admin" })).toEqual({ allowed: true })
	})

	it("refuses a key-signed session", () => {
		// Hiding the button in the menu is presentation; this is the rule.
		const verdict = mayStopFromDashboard({ role: "apikey" })
		expect(verdict.allowed).toBe(false)
	})

	it("refuses an absent session with the same message", () => {
		const verdict = mayStopFromDashboard(null)
		expect(verdict).toEqual({
			allowed: false,
			message: "Only a password session can shut the server down",
		})
	})

	it("refuses a session whose role is null", () => {
		expect(mayStopFromDashboard({ role: null }).allowed).toBe(false)
	})
})

describe("mayStopFromHook", () => {
	const secret = "s3cret"

	it("allows the right bearer token outside production", () => {
		expect(
			mayStopFromHook({ nodeEnv: "development", secret, authorization: `Bearer ${secret}` }),
		).toEqual({ allowed: true })
	})

	it("refuses in production even with the right secret", () => {
		// A deployment that may never stop this way is a different answer from
		// "wrong credential", and the routes map them to 403 and 401.
		expect(
			mayStopFromHook({ nodeEnv: "production", secret, authorization: `Bearer ${secret}` }),
		).toEqual({ allowed: false, message: "Not allowed in production" })
	})

	it("refuses when the secret is unset, without falling through to the comparison", () => {
		// The trap: an unset secret and an unset header would compare equal
		// (`!== \`Bearer ${undefined}\`` is false), letting any caller stop the server.
		expect(
			mayStopFromHook({ nodeEnv: "development", secret: undefined, authorization: null }),
		).toEqual({ allowed: false, message: "Unauthorized" })
	})

	it("refuses a wrong token", () => {
		expect(
			mayStopFromHook({ nodeEnv: "development", secret, authorization: "Bearer wrong" }),
		).toEqual({ allowed: false, message: "Unauthorized" })
	})

	it("refuses a missing header", () => {
		expect(mayStopFromHook({ nodeEnv: "development", secret, authorization: null }).allowed).toBe(
			false,
		)
	})

	it("requires the Bearer prefix", () => {
		expect(mayStopFromHook({ nodeEnv: "development", secret, authorization: secret }).allowed).toBe(
			false,
		)
	})
})
