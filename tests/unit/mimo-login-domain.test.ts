/**
 * Starting and polling a MiMo Desktop login.
 *
 * Module under test: `apps/api/src/domain/mimo-login.ts` — 115 lines, 8 exported functions, and
 * until now zero test files referencing any of them (verified by grepping all 694 test files for
 * each exported name: no hit).
 *
 * Why this file exists — two rules here are security-relevant, not cosmetic:
 *
 * - `redactedEgress` strips `user:pass@` before a proxy URL reaches the log. An unredacted URL in a
 *   log file is a credential in a log file.
 * - `mimoLoginStatus` reports `done` only when an identity is actually present. The client persists
 *   what it returns as a connection, so answering `done` without one saves a connection that can
 *   never authenticate.
 *
 * The rest is the region and redirect rules, which decide whether a login is even possible.
 *
 * User's verbatim instruction: "lanjut lupakan prompt saya sebelumnya tentang writeup karena salah
 * kirim" — continue the work, and disregard the earlier write-up instruction, which was sent by
 * mistake.
 */

import {
	directEgress,
	firstHopRefusal,
	MIMO_DEFAULT_REGION,
	MIMO_LOGIN_SESSION_SECONDS,
	MIMO_REGIONS,
	mimoLoginStatus,
	mimoLoginStatusHttp,
	needsEgressProbe,
	probedEgress,
	readMimoRegion,
	redactedEgress,
	secondHopRefusal,
} from "9router-api/domain/mimo-login"
import { describe, expect, it } from "vitest"

describe("which cluster a login targets", () => {
	it("accepts every region the UI offers", () => {
		for (const region of MIMO_REGIONS) {
			expect(readMimoRegion({ region })).toBe(region)
		}
	})

	it("normalises case, because a hand-written request need not match the dropdown", () => {
		expect(readMimoRegion({ region: "SGP" })).toBe("sgp")
		expect(readMimoRegion({ region: "  Cn  " })).toBe("cn")
	})

	it("falls back to the default rather than failing, so a stale cached dropdown still logs in", () => {
		for (const body of [{}, { region: "mars" }, { region: "" }, null, undefined, { region: 42 }]) {
			expect(readMimoRegion(body)).toBe(MIMO_DEFAULT_REGION)
		}
	})

	it("the default is one of the offered regions", () => {
		expect(MIMO_REGIONS).toContain(MIMO_DEFAULT_REGION)
	})
})

describe("when a local egress probe is worth doing", () => {
	it("CN is always direct: the page is reachable from inside its own network", () => {
		expect(needsEgressProbe("cn")).toBe(false)
	})

	it("every other cluster may need an overseas exit", () => {
		for (const region of MIMO_REGIONS.filter((r) => r !== "cn")) {
			expect(needsEgressProbe(region)).toBe(true)
		}
	})
})

describe("logging the egress decision without logging a credential", () => {
	it("no proxy means nothing to log", () => {
		expect(redactedEgress(directEgress())).toBe("")
	})

	it("strips a user:pass pair from the URL", () => {
		const egress = probedEgress("http://user:s3cret@proxy.local:8080")
		expect(redactedEgress(egress)).toBe("http://***@proxy.local:8080")
	})

	it("keeps a credential-free URL intact, because the host and port are the useful part", () => {
		const egress = probedEgress("http://proxy.local:8080")
		expect(redactedEgress(egress)).toBe("http://proxy.local:8080")
	})

	it("never leaks the password for any shape a probe might return", () => {
		const shapes = [
			"http://u:p@host:1",
			"https://user:pa%40ss@host",
			"socks5://a:b@127.0.0.1:1080",
			"http://token@host",
		]
		for (const url of shapes) {
			const logged = redactedEgress(probedEgress(url))
			expect(logged).not.toMatch(/\b(pa%40ss|p@|:b@|:s3cret)/)
		}
	})

	it("a probe that found nothing is the same decision as no probe", () => {
		expect(probedEgress(null)).toEqual(directEgress())
		expect(probedEgress("")).toEqual(directEgress())
	})

	it("a probe that found something reports where it came from", () => {
		expect(probedEgress("http://p:1")).toEqual({
			proxyUrl: "http://p:1",
			source: "local-probe",
		})
	})
})

describe("the first hop must point at the account SSO host", () => {
	it("accepts a redirect to the account host", () => {
		expect(firstHopRefusal(302, "https://account.xiaomi.com/pass/serviceLogin")).toBeNull()
	})

	it("refuses a 200 with no redirect: there is no page to hand the browser", () => {
		expect(firstHopRefusal(200, null)).toContain("no account redirect")
	})

	it("refuses a redirect to some other host", () => {
		expect(firstHopRefusal(302, "https://evil.example/login")).toContain("no account redirect")
	})

	it("names the upstream status, so an operator can tell 500 from 200", () => {
		expect(firstHopRefusal(503, null)).toContain("503")
	})
})

describe("the second hop must name a page to load", () => {
	it("accepts any redirect, because the SPA page carries its own parameters", () => {
		expect(secondHopRefusal(302, "https://account.xiaomi.com/fe/serviceLogin?x=1")).toBeNull()
	})

	it("refuses when there is nowhere to go", () => {
		expect(secondHopRefusal(200, null)).toContain("Unexpected serviceLogin response")
	})

	it("names the status", () => {
		expect(secondHopRefusal(500, null)).toContain("500")
	})
})

describe("what a status poll answers", () => {
	it("a session the browser no longer has is expired, never pending", () => {
		// Pending here would spin the modal forever on a cookie that is already gone.
		expect(
			mimoLoginStatus({ sessionPresent: false, stateMatches: true, identityPresent: true }),
		).toBe("expired")
	})

	it("a state mismatch is expired even with a session present, because the handshake was not ours", () => {
		expect(
			mimoLoginStatus({ sessionPresent: true, stateMatches: false, identityPresent: true }),
		).toBe("expired")
	})

	it("a live session with no identity yet is pending", () => {
		expect(
			mimoLoginStatus({ sessionPresent: true, stateMatches: true, identityPresent: false }),
		).toBe("pending")
	})

	it("done requires an identity, because the client saves what this returns as a connection", () => {
		expect(mimoLoginStatus({ sessionPresent: true, stateMatches: true, identityPresent: true })).toBe(
			"done",
		)
	})

	it("expired maps to 404 and everything else to 200", () => {
		expect(mimoLoginStatusHttp("expired")).toBe(404)
		for (const status of ["pending", "done", "error"] as const) {
			expect(mimoLoginStatusHttp(status)).toBe(200)
		}
	})

	it("the session window is the fifteen minutes the modal assumes", () => {
		expect(MIMO_LOGIN_SESSION_SECONDS).toBe(900)
	})
})
