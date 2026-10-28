import { describe, expect, it } from "vitest"
import {
	budgetFraction,
	budgetOf,
	isExhausted,
	isUnlimited,
	limitCapOf,
	limitKindOf,
	limitUsedOf,
	spentTodayOf,
	todayKey,
} from "@/lib/usage/keyBudget"

/**
 * These cases lock the budget contract that the keys table and the usage report
 * both consume. Each branch is exercised explicitly, including the ones the old
 * inline copies could not reach (unknown kind, empty string, missing columns).
 */
describe("limitKindOf", () => {
	it("keeps the two non-default kinds", () => {
		expect(limitKindOf({ limitKind: "cost" })).toBe("cost")
		expect(limitKindOf({ limitKind: "requests" })).toBe("requests")
	})

	it("defaults to tokens for a missing, empty or unknown kind", () => {
		expect(limitKindOf({})).toBe("tokens")
		expect(limitKindOf({ limitKind: "" })).toBe("tokens")
		expect(limitKindOf({ limitKind: "banana" })).toBe("tokens")
		expect(limitKindOf(null)).toBe("tokens")
		expect(limitKindOf(undefined)).toBe("tokens")
	})

	it("defaults to tokens when the column is not a string", () => {
		expect(limitKindOf({ limitKind: 42 })).toBe("tokens")
		expect(limitKindOf({ limitKind: { kind: "cost" } })).toBe("tokens")
	})
})

describe("spentTodayOf", () => {
	const today = "2026-01-15"

	it("returns the counter when it was stamped today", () => {
		expect(spentTodayOf({ costDay: today, costSpent: 2.5 }, today)).toBe(2.5)
	})

	it("returns zero when the stamp is a previous day", () => {
		expect(spentTodayOf({ costDay: "2026-01-14", costSpent: 2.5 }, today)).toBe(0)
	})

	it("returns zero when the stamp is missing entirely", () => {
		expect(spentTodayOf({ costSpent: 2.5 }, today)).toBe(0)
	})

	it("coerces a null, undefined or non-numeric counter to zero", () => {
		expect(spentTodayOf({ costDay: today, costSpent: null }, today)).toBe(0)
		expect(spentTodayOf({ costDay: today, costSpent: undefined }, today)).toBe(0)
		expect(spentTodayOf({ costDay: today, costSpent: "abc" }, today)).toBe(0)
	})

	it("accepts a numeric string as the counter", () => {
		expect(spentTodayOf({ costDay: today, costSpent: "3.75" }, today)).toBe(3.75)
	})

	it("tolerates a null key", () => {
		expect(spentTodayOf(null, today)).toBe(0)
	})
})

describe("todayKey", () => {
	it("formats as the UTC YYYY-MM-DD that costDay is stamped with", () => {
		expect(todayKey(new Date("2026-01-15T23:59:59Z"))).toBe("2026-01-15")
		// 00:30 UTC is still the previous day in some zones — the stamp is UTC, always.
		expect(todayKey(new Date("2026-01-16T00:30:00Z"))).toBe("2026-01-16")
	})

	it("zero-pads single digit months and days", () => {
		expect(todayKey(new Date("2026-03-04T10:00:00Z"))).toBe("2026-03-04")
	})
})

describe("limitCapOf", () => {
	it("reads the column that matches the kind", () => {
		const key = { tokenLimit: 1000, dailyCostLimit: 2.5, requestLimit: 300 }
		expect(limitCapOf(key, "tokens")).toBe(1000)
		expect(limitCapOf(key, "cost")).toBe(2.5)
		expect(limitCapOf(key, "requests")).toBe(300)
	})

	it("derives the kind from the key when none is passed", () => {
		expect(limitCapOf({ limitKind: "cost", dailyCostLimit: 4 })).toBe(4)
	})

	it("prefers an explicit token cap over the stored column", () => {
		const key = { tokenLimit: 1000 }
		expect(limitCapOf(key, "tokens", 7000)).toBe(7000)
	})

	it("treats a null, missing or non-numeric cap as zero", () => {
		expect(limitCapOf({}, "tokens")).toBe(0)
		expect(limitCapOf({ tokenLimit: null }, "tokens")).toBe(0)
		expect(limitCapOf({ requestLimit: "nope" }, "requests")).toBe(0)
	})
})

describe("limitUsedOf", () => {
	it("reads the used column that matches the kind", () => {
		const key = { usedTokens: 400, usedRequests: 12, costDay: "2026-01-15", costSpent: 1.25 }
		expect(limitUsedOf(key, "tokens", undefined, "2026-01-15")).toBe(400)
		expect(limitUsedOf(key, "requests", undefined, "2026-01-15")).toBe(12)
		expect(limitUsedOf(key, "cost", undefined, "2026-01-15")).toBe(1.25)
	})

	it("applies the staleness rule to the cost kind", () => {
		const key = { costDay: "2026-01-14", costSpent: 9.99 }
		expect(limitUsedOf(key, "cost", undefined, "2026-01-15")).toBe(0)
	})

	it("prefers an explicit token used value over the stored column", () => {
		expect(limitUsedOf({ usedTokens: 400 }, "tokens", 900)).toBe(900)
	})
})

describe("isUnlimited / isExhausted / budgetFraction", () => {
	it("treats a zero or negative cap as unlimited", () => {
		expect(isUnlimited(0)).toBe(true)
		expect(isUnlimited(-5)).toBe(true)
		expect(isUnlimited(1)).toBe(false)
	})

	it("never reports an unlimited budget as exhausted", () => {
		expect(isExhausted(0, 1_000_000)).toBe(false)
		expect(isExhausted(0, 0)).toBe(false)
	})

	it("is exhausted exactly when used reaches the cap", () => {
		expect(isExhausted(100, 99)).toBe(false)
		expect(isExhausted(100, 100)).toBe(true)
		expect(isExhausted(100, 150)).toBe(true)
	})

	it("clamps the fraction to [0, 1] so an overrun cannot render past the bar", () => {
		expect(budgetFraction(100, 50)).toBe(0.5)
		expect(budgetFraction(100, 250)).toBe(1)
		expect(budgetFraction(0, 250)).toBe(0)
	})
})

describe("budgetOf", () => {
	it("resolves kind, cap, used and progress together for tokens", () => {
		const snapshot = budgetOf({ limitKind: "tokens", tokenLimit: 1000, usedTokens: 250 })
		expect(snapshot).toEqual({
			kind: "tokens",
			cap: 1000,
			used: 250,
			exhausted: false,
			fraction: 0.25,
		})
	})

	it("honours the pre-resolved token cap and used values", () => {
		const snapshot = budgetOf(
			{ limitKind: "tokens", tokenLimit: 1000, usedTokens: 250 },
			{ tokenCap: 1000, tokenUsed: 1000 },
		)
		expect(snapshot.used).toBe(1000)
		expect(snapshot.exhausted).toBe(true)
	})

	it("resolves a cost budget against today only", () => {
		const today = "2026-01-15"
		const stale = budgetOf(
			{ limitKind: "cost", dailyCostLimit: 2, costDay: "2026-01-14", costSpent: 2 },
			{ today },
		)
		expect(stale.used).toBe(0)
		expect(stale.exhausted).toBe(false)

		const fresh = budgetOf(
			{ limitKind: "cost", dailyCostLimit: 2, costDay: today, costSpent: 2 },
			{ today },
		)
		expect(fresh.exhausted).toBe(true)
	})

	it("reports an uncapped key as unlimited with no progress", () => {
		const snapshot = budgetOf({ limitKind: "requests", requestLimit: 0, usedRequests: 42 })
		expect(snapshot.cap).toBe(0)
		expect(snapshot.exhausted).toBe(false)
		expect(snapshot.fraction).toBe(0)
	})
})
