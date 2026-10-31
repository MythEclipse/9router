import { describe, expect, it } from "vitest"
import { shortDate } from "../../apps/web/src/app/(dashboard)/dashboard/usage/components/TokenSavingsTab.js"

describe("savings axis label", () => {
	it("names the month and the day, not a bare MM-DD", () => {
		expect(shortDate("2026-10-29")).toBe("Oct 29")
	})

	it("does not zero-pad the day", () => {
		expect(shortDate("2026-01-05")).toBe("Jan 5")
	})

	it("keeps two months of a 60d window distinguishable", () => {
		// The pre-fix label was `slice(5)`, so these both read "05".
		expect(shortDate("2026-10-05")).not.toBe(shortDate("2026-11-05"))
	})

	it("returns the input unchanged when it is not an ISO date", () => {
		expect(shortDate("not-a-date")).toBe("not-a-date")
	})
})
