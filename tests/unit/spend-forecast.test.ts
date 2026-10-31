/**
 * The spend projection, and the three ways its arithmetic used to lie.
 *
 * The dashboard could always say what was spent. These tests cover the figures it could not
 * say: the projected total, and — when a cap is supplied — when it runs out. Each case below
 * is one of the silent wrong answers described at the top of `domain/spend-forecast.ts`:
 *
 * - a partial day averaged in raw understates the rate;
 * - zero history produces `Infinity`, which JSON turns into `null`;
 * - junk in `usageDaily` (`null`, negative, non-numeric) either cancels real spend or poisons
 *   the mean with `NaN`.
 */

import type { UsageReportPort } from "9router-api/application/usage/report-usage"
import { makeSpendForecast } from "9router-api/application/usage/spend-forecast"
import { elapsedDayFraction, projectSpend } from "9router-api/domain/spend-forecast"
import { describe, expect, it } from "vitest"

/** A local instant, because the day fraction reads the local clock. */
const at = (hour: number, minute = 0) => new Date(2026, 9, 31, hour, minute, 0, 0)

describe("elapsedDayFraction", () => {
	it("reads the local clock, so a local day is not extrapolated against a UTC one", () => {
		expect(elapsedDayFraction(at(6))).toBeCloseTo(0.25, 6)
		expect(elapsedDayFraction(at(18))).toBeCloseTo(0.75, 6)
	})

	it("clamps just after midnight, where an uncapped ratio turns one request into a day", () => {
		// 00:00:00 would divide by zero; 00:00:30 would multiply the first request by 2880.
		expect(elapsedDayFraction(at(0, 0))).toBeCloseTo(1 / 24, 6)
	})

	it("never exceeds a full day", () => {
		expect(elapsedDayFraction(new Date(2026, 9, 31, 23, 59, 59))).toBeLessThanOrEqual(1)
	})
})

describe("projectSpend — the partial day", () => {
	it("extrapolates today before it joins the mean", () => {
		// Six complete days at 1.00, and a quarter of today already at 0.25.
		// Averaging 0.25 in raw would give 0.89/day and understate the month.
		const forecast = projectSpend({
			dailyCost: [1, 1, 1, 1, 1, 1, 0.25],
			now: at(6),
		})

		expect(forecast.historyDays).toBe(6)
		expect(forecast.todaySoFar).toBeCloseTo(0.25, 6)
		expect(forecast.todayProjected).toBeCloseTo(1, 6)
		expect(forecast.dailyRate).toBeCloseTo(1, 6)
		expect(forecast.observedSpend).toBeCloseTo(6.25, 6)
	})

	it("keeps the raw figure available so the card never shows the extrapolation as spend", () => {
		const forecast = projectSpend({ dailyCost: [2, 2, 2, 2, 2, 2, 0.5], now: at(6) })

		expect(forecast.todaySoFar).toBeCloseTo(0.5, 6)
		expect(forecast.todayProjected).toBeCloseTo(2, 6)
		expect(forecast.observedSpend).toBeCloseTo(12.5, 6)
	})
})

describe("projectSpend — the projected total", () => {
	it("covers the whole horizon, not one more day each time it is called", () => {
		// A 7-day series asked for 7 days: six complete days, today projected, nothing after.
		const forecast = projectSpend({ dailyCost: [1, 1, 1, 1, 1, 1, 0.5], now: at(12) })

		expect(forecast.horizonDays).toBe(7)
		expect(forecast.projectedTotal).toBeCloseTo(7, 6)
	})

	it("fills the days still to come at the current rate", () => {
		// A 3-day series projected onto a 30-day window: 2 complete, today, 27 more.
		const forecast = projectSpend({
			dailyCost: [2, 2, 1],
			now: at(12),
			horizonDays: 30,
		})

		// Two complete days (4.00) + today projected (2.00) + 27 days still to come (54.00).
		expect(forecast.dailyRate).toBeCloseTo(2, 6)
		expect(forecast.projectedTotal).toBeCloseTo(4 + 2 + 2 * 27, 6)
	})

	it("defaults the horizon to the series length", () => {
		expect(projectSpend({ dailyCost: [1, 1, 1], now: at(12) }).horizonDays).toBe(3)
	})
})

describe("projectSpend — nothing to project from", () => {
	it("answers zero rather than Infinity for an install with no traffic", () => {
		const forecast = projectSpend({ dailyCost: [], now: at(12), budgetCap: 10 })

		expect(forecast.confidence).toBe("none")
		expect(forecast.dailyRate).toBe(0)
		expect(forecast.projectedTotal).toBe(0)
		// `Infinity` serialises to `null` anyway; answering it here would make the JSON look
		// like a legitimately unknown ETA instead of "there is no rate".
		expect(forecast.hoursToExhaustion).toBeNull()
		expect(forecast.exhaustedAt).toBeNull()
	})

	it("calls a projection built on one partial day thin", () => {
		const forecast = projectSpend({ dailyCost: [0.5], now: at(12) })

		expect(forecast.historyDays).toBe(0)
		expect(forecast.confidence).toBe("thin")
		expect(forecast.dailyRate).toBeCloseTo(1, 6)
	})

	it("calls a projection with enough history ok", () => {
		expect(projectSpend({ dailyCost: [1, 1, 1, 1], now: at(12) }).confidence).toBe("ok")
	})
})

describe("projectSpend — junk in the rollup", () => {
	it("counts an unusable row as zero instead of letting it cancel real spend", () => {
		const forecast = projectSpend({
			dailyCost: [null, -5, "2", Number.NaN, undefined],
			now: at(12),
		})

		// -5 must not subtract, NaN must not poison the sum, "2" is the one usable row.
		expect(forecast.observedSpend).toBeCloseTo(2, 6)
		expect(Number.isFinite(forecast.dailyRate)).toBe(true)
		expect(Number.isFinite(forecast.projectedTotal)).toBe(true)
	})
})

describe("projectSpend — the budget", () => {
	it("reports the hours left at the current rate", () => {
		// Rate 1.00/day, 3.50 left: 84 hours.
		const forecast = projectSpend({
			dailyCost: [1, 1, 1, 1, 1, 1, 0.5],
			now: at(12),
			budgetCap: 10,
		})

		expect(forecast.budgetCap).toBe(10)
		expect(forecast.budgetRemaining).toBeCloseTo(3.5, 6)
		expect(forecast.hoursToExhaustion).toBeCloseTo(84, 6)
		expect(forecast.exhaustedAt).toBe(new Date(at(12).getTime() + 84 * 3_600_000).toISOString())
	})

	it("reports an already-spent cap as exhausted now, not in the past", () => {
		const forecast = projectSpend({
			dailyCost: [1, 1, 1, 1, 1, 1, 0.5],
			now: at(12),
			budgetCap: 5,
		})

		expect(forecast.budgetRemaining).toBeLessThan(0)
		expect(forecast.hoursToExhaustion).toBe(0)
		expect(forecast.exhaustedAt).toBe(at(12).toISOString())
	})

	it("says nothing about exhaustion when no cap was supplied", () => {
		const forecast = projectSpend({ dailyCost: [1, 1, 1, 1], now: at(12) })

		expect(forecast.budgetCap).toBeNull()
		expect(forecast.budgetRemaining).toBeNull()
		expect(forecast.projectedOverspend).toBeNull()
		expect(forecast.hoursToExhaustion).toBeNull()
	})

	it("treats a zero or unusable cap as absent rather than as already spent", () => {
		// `0` would read as a cap with nothing left, reporting every key as exhausted.
		expect(projectSpend({ dailyCost: [1, 1], now: at(12), budgetCap: 0 }).budgetCap).toBeNull()
		expect(
			projectSpend({ dailyCost: [1, 1], now: at(12), budgetCap: Number.NaN }).budgetCap,
		).toBeNull()
	})

	it("says whether the window closes over or under the cap", () => {
		const over = projectSpend({ dailyCost: [2, 2, 1], now: at(12), horizonDays: 30, budgetCap: 20 })
		const under = projectSpend({ dailyCost: [1, 1, 1], now: at(12), horizonDays: 3, budgetCap: 20 })

		expect(over.projectedOverspend).toBeGreaterThan(0)
		expect(under.projectedOverspend).toBeLessThan(0)
	})
})

/** A sparks port that answers with the given cost series. */
function sparksPort(cost: unknown, calls: Array<Record<string, unknown>> = []): UsageReportPort {
	return {
		stats: async () => ({}),
		chart: async () => [],
		sparks: async (period, apiKeyFilter, allowedModels) => {
			calls.push({ period, apiKeyFilter, allowedModels })
			return { days: 30, totals: { cost }, heatTimestamps: [] }
		},
		history: async () => [],
		recentLogs: async () => [],
	}
}

describe("makeSpendForecast", () => {
	it("reads the same series the sparkline card reads, with the same scope", async () => {
		const calls: Array<Record<string, unknown>> = []
		const useCase = makeSpendForecast({ usage: sparksPort([1, 1, 1], calls) })

		const result = await useCase.forecast(
			"30d",
			{ apiKeyFilter: "key-1", allowedModels: "claude-*" },
			20,
		)

		expect(calls).toEqual([{ period: "30d", apiKeyFilter: "key-1", allowedModels: "claude-*" }])
		expect(result.period).toBe("30d")
		expect(result.forecast.budgetCap).toBe(20)
	})

	it("defaults to the sparkline's own month, not the usage default week", async () => {
		const calls: Array<Record<string, unknown>> = []
		const useCase = makeSpendForecast({ usage: sparksPort([1, 1], calls) })

		await useCase.forecast(undefined, { apiKeyFilter: null, allowedModels: "*" })

		expect(calls[0]?.period).toBe("30d")
	})

	it("refuses a period it cannot answer instead of substituting one", async () => {
		const useCase = makeSpendForecast({ usage: sparksPort([1, 1]) })

		await expect(
			useCase.forecast("90d", { apiKeyFilter: null, allowedModels: "*" }),
		).rejects.toMatchObject({ code: "VALIDATION", status: 400 })
	})

	it("reports a payload without a cost series as a wiring fault, not as zero spend", async () => {
		// Answering 0 here is the failure mode: a broken host would look like an idle install.
		const useCase = makeSpendForecast({
			usage: { ...sparksPort([]), sparks: async () => ({ days: 30, totals: {} }) },
		})

		await expect(
			useCase.forecast(undefined, { apiKeyFilter: null, allowedModels: "*" }),
		).rejects.toMatchObject({ code: "INTERNAL" })
	})
})
