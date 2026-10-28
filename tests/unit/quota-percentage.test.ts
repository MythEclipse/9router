import { describe, expect, it } from "vitest"
import { calculatePercentage } from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/quotaPercentage"

describe("calculatePercentage", () => {
	it("reads a missing total as 0", () => {
		expect(calculatePercentage(10, 0)).toBe(0)
		expect(calculatePercentage(10, null)).toBe(0)
		expect(calculatePercentage(10, undefined)).toBe(0)
	})

	it("reads a missing or negative remaining as fully used", () => {
		expect(calculatePercentage(0, 100)).toBe(100)
		expect(calculatePercentage(null, 100)).toBe(100)
		expect(calculatePercentage(undefined, 100)).toBe(100)
		expect(calculatePercentage(-5, 100)).toBe(100)
	})

	it("clamps to 0 when remaining is at or past the total", () => {
		expect(calculatePercentage(100, 100)).toBe(0)
		expect(calculatePercentage(150, 100)).toBe(0)
	})

	it("rounds to a whole percent", () => {
		expect(calculatePercentage(50, 100)).toBe(50)
		expect(calculatePercentage(33, 100)).toBe(67)
		expect(calculatePercentage(1, 3)).toBe(67)
		expect(calculatePercentage(2, 3)).toBe(33)
	})

	it("never returns a fraction or leaves the 0-100 range", () => {
		for (const used of [-1, 0, 1, 33, 50, 66, 99, 100, 101]) {
			for (const total of [0, 1, 3, 100]) {
				const pct = calculatePercentage(used, total)
				expect(Number.isInteger(pct)).toBe(true)
				expect(pct).toBeGreaterThanOrEqual(0)
				expect(pct).toBeLessThanOrEqual(100)
			}
		}
	})

	it("matches the expression it replaced", () => {
		const legacy = (used: number, total: number) => {
			if (!total || total === 0) return 0
			if (!used || used < 0) return 100
			if (used >= total) return 0
			return Math.round(((total - used) / total) * 100)
		}
		for (const used of [-10, -1, 0, 1, 50, 99, 100, 200]) {
			for (const total of [0, 1, 7, 100, 1000]) {
				expect(calculatePercentage(used, total)).toBe(legacy(used, total))
			}
		}
	})
})
