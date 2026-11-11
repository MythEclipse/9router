/**
 * Quota-exhaustion rules: what parks an account, and for how long.
 *
 * The behaviour under test is the one the dashboard already displays — a window at 0% with a
 * refill time ahead — read by the request path so it can skip that account instead of spending a
 * request to be told 429.
 */

import {
	clearQuotaObservations,
	findConnectionQuotaBlock,
	findExhaustedQuotaWindow,
	forgetQuotaObservation,
	normalizeModelToken,
	primeQuotaObservation,
	rowAppliesToModel,
	rowRemainingPercentage,
} from "open-sse/services/quotaExhaustion.js"
import { beforeEach, describe, expect, it } from "vitest"

const NOW = Date.parse("2026-11-11T12:00:00.000Z")
const IN_SIX_DAYS = "2026-11-17T14:20:00.000Z"
const IN_AN_HOUR = "2026-11-11T13:00:00.000Z"
const YESTERDAY = "2026-11-10T12:00:00.000Z"

beforeEach(() => {
	clearQuotaObservations()
})

describe("rowRemainingPercentage", () => {
	it("reads remainingPercentage as a percentage", () => {
		expect(rowRemainingPercentage({ used: 400, total: 1000, remainingPercentage: 60 })).toBe(60)
	})

	it("inverts a row that reports the used percentage", () => {
		expect(
			rowRemainingPercentage({
				used: 0,
				total: 100,
				remainingPercentage: 100,
				percentageIsUsed: true,
			}),
		).toBe(0)
	})

	it("derives the percentage from used/total when the row omits it", () => {
		expect(rowRemainingPercentage({ used: 1000, total: 1000 })).toBe(0)
		expect(rowRemainingPercentage({ used: 250, total: 1000 })).toBe(75)
	})

	it("derives the percentage from an absolute remainder", () => {
		expect(rowRemainingPercentage({ used: 0, total: 500, remaining: 0 })).toBe(0)
	})

	it("says nothing when the row carries no usable numbers", () => {
		expect(rowRemainingPercentage({ used: 0, total: 0 })).toBeNull()
		expect(rowRemainingPercentage(null)).toBeNull()
	})
})

describe("findExhaustedQuotaWindow", () => {
	it("parks the account when the weekly window is at 0% with a reset ahead", () => {
		// The reported case: "Gemini (Weekly) 0% · 1,000 / 1,000 · in 6d 2h 20m".
		const block = findExhaustedQuotaWindow(
			{
				gemini_weekly: {
					name: "Gemini (Weekly)",
					used: 1000,
					total: 1000,
					remainingPercentage: 0,
					resetAt: IN_SIX_DAYS,
				},
			},
			"gemini-3.8-flash",
			NOW,
		)
		expect(block).toMatchObject({ label: "Gemini (Weekly)", resetAt: IN_SIX_DAYS })
	})

	it("does not park on a window that already reset", () => {
		expect(
			findExhaustedQuotaWindow(
				{ weekly: { used: 1000, total: 1000, remainingPercentage: 0, resetAt: YESTERDAY } },
				"claude-opus-5-5",
				NOW,
			),
		).toBeNull()
	})

	it("does not park on a 0% row with no refill time", () => {
		expect(
			findExhaustedQuotaWindow(
				{ credits: { used: 100, total: 100, remainingPercentage: 0 } },
				"gpt-6",
				NOW,
			),
		).toBeNull()
	})

	it("ignores unlimited rows even when they read 0%", () => {
		expect(
			findExhaustedQuotaWindow(
				{
					requests: { used: 0, total: 0, remainingPercentage: 0, resetAt: IN_SIX_DAYS, unlimited: true },
				},
				"gpt-6",
				NOW,
			),
		).toBeNull()
	})

	it("parks a whole account on a window row that names no model", () => {
		const block = findExhaustedQuotaWindow(
			{
				"5h": {
					name: "Session (5h)",
					used: 100,
					total: 100,
					remainingPercentage: 0,
					resetAt: IN_AN_HOUR,
				},
			},
			"claude-sonnet-5-5",
			NOW,
		)
		expect(block?.key).toBe("5h")
	})

	it("parks only the model a per-model row names", () => {
		const quotas = {
			"weekly Claude Sonnet 5 (7d)": {
				used: 100,
				total: 100,
				remainingPercentage: 0,
				resetAt: IN_SIX_DAYS,
			},
		}
		expect(findExhaustedQuotaWindow(quotas, "claude-sonnet-5-5", NOW)).not.toBeNull()
		expect(findExhaustedQuotaWindow(quotas, "claude-opus-5-5", NOW)).toBeNull()
	})

	it("blocks a whole family on its shared pool and nothing else", () => {
		const quotas = {
			gemini_weekly: { used: 1000, total: 1000, remainingPercentage: 0, resetAt: IN_SIX_DAYS },
		}
		expect(findExhaustedQuotaWindow(quotas, "gemini-3.8-flash", NOW)).not.toBeNull()
		expect(findExhaustedQuotaWindow(quotas, "claude-opus-5-5", NOW)).toBeNull()
	})

	it("waits for the latest refill when several windows are spent", () => {
		const block = findExhaustedQuotaWindow(
			{
				"5h": { used: 100, total: 100, remainingPercentage: 0, resetAt: IN_AN_HOUR },
				weekly: { used: 100, total: 100, remainingPercentage: 0, resetAt: IN_SIX_DAYS },
			},
			null,
			NOW,
		)
		expect(block?.resetAt).toBe(IN_SIX_DAYS)
	})
})

describe("model matching", () => {
	it("strips the provider prefix and tier suffix from a model id", () => {
		expect(normalizeModelToken("antigravity/gemini-3.8-flash (high)")).toBe("gemini-3.8-flash")
		expect(normalizeModelToken("claude-opus-5-5-thinking")).toBe("claude-opus-5-5")
	})

	it("treats a row with no model name as account-wide", () => {
		expect(rowAppliesToModel("monthly", "gemini-3.8-flash")).toBe(true)
		expect(rowAppliesToModel("bonus pack 1", "gemini-3.8-flash")).toBe(true)
	})

	it("does not apply another model's row to this request", () => {
		expect(rowAppliesToModel("weekly claude sonnet 5 (7d)", "gemini-3.8-flash")).toBe(false)
	})
})

describe("observation cache", () => {
	it("parks the connection the reading named", () => {
		primeQuotaObservation(
			"conn-1",
			"codebuddy-cn",
			{
				"5h": {
					name: "Session (5h)",
					used: 40,
					total: 40,
					remainingPercentage: 0,
					resetAt: IN_AN_HOUR,
				},
			},
			NOW,
		)
		expect(findConnectionQuotaBlock("conn-1", "claude-sonnet-5-5", NOW)).toMatchObject({
			resetAt: IN_AN_HOUR,
		})
	})

	it("returns nothing for a connection that was never read", () => {
		expect(findConnectionQuotaBlock("unknown", "claude-sonnet-5-5", NOW)).toBeNull()
	})

	it("lets a fresh reading replace a stale one", () => {
		primeQuotaObservation(
			"conn-2",
			"codebuddy-cn",
			{ "5h": { used: 40, total: 40, remainingPercentage: 0, resetAt: IN_AN_HOUR } },
			NOW,
		)
		primeQuotaObservation(
			"conn-2",
			"codebuddy-cn",
			{ "5h": { used: 0, total: 40, remainingPercentage: 100, resetAt: IN_AN_HOUR } },
			NOW + 1000,
		)
		expect(findConnectionQuotaBlock("conn-2", "claude-sonnet-5-5", NOW + 2000)).toBeNull()
	})

	it("forgets a connection on request", () => {
		primeQuotaObservation(
			"conn-3",
			"codebuddy-cn",
			{ "5h": { used: 40, total: 40, remainingPercentage: 0, resetAt: IN_AN_HOUR } },
			NOW,
		)
		forgetQuotaObservation("conn-3")
		expect(findConnectionQuotaBlock("conn-3", "claude-sonnet-5-5", NOW)).toBeNull()
	})
})
