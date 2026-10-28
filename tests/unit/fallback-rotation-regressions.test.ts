// Regression tests for the fallback / proxy-rotation audit.
//
// Each case here is a bug that shipped GREEN: the existing suite passed while
// the behaviour was wrong, because nothing pinned the specific composition.
// Keep them narrow — one assertion per discovered failure mode.

import { describe, expect, it } from "vitest"
import { checkFallbackError, shouldRotateProxy } from "../../open-sse/services/accountFallback.js"
import { getRotatedModels } from "../../open-sse/services/combo.js"
import { pickProxyPoolId } from "../../src/lib/network/connectionProxy.js"
import { isSupportedProxyScheme } from "../../src/lib/network/outboundProxy.js"
import {
	markProxyUnhealthy,
	pickSmartProxyPoolId,
	resetProxyHealth,
} from "../../src/lib/network/proxyHealth.js"

describe("ERROR_RULES: a benign client 4xx must not be read as upstream saturation", () => {
	// The rule used to be the bare substring "capacity", which appears in bodies
	// the CALLER caused. A text rule outranks the client-mistake rules below it,
	// so the account was cooled down and a proxy IP burned over the caller's typo.
	const benign = [
		"`max_tokens` exceeds the model's maximum output capacity of 8192",
		"invalid request: capacity parameter not supported",
		"insufficient capacity in the capacity field",
	]

	for (const text of benign) {
		it(`keeps a healthy account out of cooldown: ${text.slice(0, 40)}`, () => {
			const result = checkFallbackError(400, text, 0, "gemini")
			expect(result.shouldFallback).toBe(false)
			expect(result.requestScoped).toBe(true)
			expect(shouldRotateProxy(400, text)).toBe(false)
		})
	}

	it("still detects genuine upstream saturation", () => {
		for (const text of [
			"service at capacity, please retry",
			"upstream is over capacity right now",
			"no capacity available",
			"model capacity limit reached",
		]) {
			expect(checkFallbackError(429, text, 0, "gemini").shouldFallback).toBe(true)
			expect(shouldRotateProxy(429, text)).toBe(true)
		}
	})
})

describe("pickSmartProxyPoolId: the all-blocked path picks the soonest recovery", () => {
	// Regression: the sort key used `blocked.get(id) ?? 0`, so an UNBLOCKED entry
	// sorted to the front (0 ms) and could be returned while cooling.
	it("returns the pool whose cooldown ends first", () => {
		resetProxyHealth()
		const pools = ["p1", "p2", "p3"]
		markProxyUnhealthy("prov", "p1", 60_000)
		markProxyUnhealthy("prov", "p2", 5_000)
		markProxyUnhealthy("prov", "p3", 30_000)

		expect(pickSmartProxyPoolId(pools, "prov", new Set(pools))).toBe("p2")
	})
})

describe("pickProxyPoolId: an exhausted request never restarts on a failed pool", () => {
	it("returns null when every pool was already tried", () => {
		const pools = ["p1", "p2", "p3"]
		const result = pickProxyPoolId(pools, "round-robin", "prov", {
			excludePoolIds: new Set(pools),
		})
		// Must NOT be "p1" — re-handing a known-bad pool burns the retry budget and
		// hides exhaustion from the caller.
		expect(result).toBeNull()
	})

	it("honours exclusion for a single-pool list too", () => {
		expect(
			pickProxyPoolId(["only"], "none", "prov", { excludePoolIds: new Set(["only"]) }),
		).toBeNull()
	})

	it("does not advance the rotation twice for one failed request", () => {
		const pools = ["p1", "p2", "p3"]
		const sequence = []
		for (let i = 0; i < 6; i++) {
			const first = pickProxyPoolId(pools, "round-robin", "rr-prov")
			sequence.push(first)
			// The retry within the same request must move on WITHOUT shifting the
			// cursor used by the next request.
			const retry = pickProxyPoolId(pools, "round-robin", "rr-prov", {
				excludePoolIds: new Set([first]),
			})
			expect(retry).not.toBe(first)
		}
		expect(sequence).toEqual(["p1", "p2", "p3", "p1", "p2", "p3"])
	})
})

describe("proxy schemes: the settings validator agrees with the transport", () => {
	// socks* used to be accepted here but rejected by Bun's fetch at request time.
	// Because a configured proxy blocks the direct fallback, that made the pool
	// permanently dead while the dashboard reported it healthy.
	it("rejects socks schemes the serving runtime cannot dial", () => {
		for (const url of [
			"socks5://127.0.0.1:1080",
			"socks4://127.0.0.1:1080",
			"socks5h://127.0.0.1:1080",
			"socks4a://127.0.0.1:1080",
		]) {
			expect(isSupportedProxyScheme(url)).toBe(false)
		}
	})

	it("accepts http and https", () => {
		expect(isSupportedProxyScheme("http://127.0.0.1:7890")).toBe(true)
		expect(isSupportedProxyScheme("https://proxy.example.com:443")).toBe(true)
	})

	it("rejects garbage without throwing", () => {
		expect(isSupportedProxyScheme("garbage::://")).toBe(false)
		expect(isSupportedProxyScheme("")).toBe(false)
		expect(isSupportedProxyScheme(null)).toBe(false)
	})
})

describe("getRotatedModels: the sticky counter is positional, not per-request-reset", () => {
	// sticky=3 must rotate only every 3rd request. This is the documented contract
	// the combo settings UI exposes; a regression silently changes routing.
	it("advances the head only once per sticky window", () => {
		const models = ["a", "b", "c", "d"]
		const heads = []
		for (let i = 0; i < 6; i++) heads.push(getRotatedModels(models, "sticky3", "round-robin", 3)[0])
		expect(heads).toEqual(["a", "a", "a", "b", "b", "b"])
	})

	it("returns the list unchanged for a single model", () => {
		expect(getRotatedModels(["solo"], "one", "round-robin", 5)).toEqual(["solo"])
	})
})
