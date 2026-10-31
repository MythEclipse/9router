/**
 * Cost per model, in the units a routing decision is made in.
 *
 * The two properties worth locking: a denominator of zero must answer `null` (not `NaN`, not
 * `Infinity`, and not `0`, which would top a "cheapest per token" list), and the ranking must
 * be by rate rather than by total — the whole point of the panel.
 */

import { makeModelCostComparison } from "9router-api/application/usage/model-cost-comparison"
import { compareModelCosts, type ModelCostInput } from "9router-api/domain/model-cost-comparison"
import { describe, expect, it } from "vitest"

const row = (over: Partial<ModelCostInput> = {}): ModelCostInput => ({
	model: "claude-sonnet-4.5",
	provider: "anthropic",
	requests: 100,
	totalCost: 1,
	promptTokens: 100_000,
	completionTokens: 50_000,
	totalTokens: 150_000,
	...over,
})

describe("compareModelCosts — rates", () => {
	it("converts a total into a cost per request and per million tokens", () => {
		const [only] = compareModelCosts([row()]).rows

		expect(only?.costPerRequest).toBeCloseTo(0.01, 10)
		expect(only?.costPerMillionTokens).toBeCloseTo((1 / 150_000) * 1_000_000, 10)
	})

	it("answers null, not Infinity, when the model served no requests", () => {
		const [only] = compareModelCosts([row({ requests: 0 })]).rows

		expect(only?.costPerRequest).toBeNull()
	})

	it("answers null when cost was billed but no tokens were reported", () => {
		// An upstream that omits usage: a `0` here would win every "cheapest per token" badge.
		const [only] = compareModelCosts([
			row({ totalTokens: 0, promptTokens: 0, completionTokens: 0 }),
		]).rows

		expect(only?.costPerMillionTokens).toBeNull()
	})

	it("falls back to prompt+completion when no total is stored", () => {
		const [only] = compareModelCosts([row({ totalTokens: 0 })]).rows

		expect(only?.tokens).toBe(150_000)
	})
})

describe("compareModelCosts — ranking", () => {
	it("orders rows by total cost, which is the triage order", () => {
		const { rows } = compareModelCosts([
			row({ model: "cheap-total", totalCost: 1 }),
			row({ model: "dear-total", totalCost: 9 }),
		])

		expect(rows.map((r) => r.model)).toEqual(["dear-total", "cheap-total"])
	})

	it("ranks the per-token extremes by rate, not by total", () => {
		// `heavy` costs more in total but is cheaper per token: it served 100x the tokens.
		const { cheapestPerMillionTokens, dearestPerMillionTokens } = compareModelCosts([
			row({ model: "light", totalCost: 1, totalTokens: 10_000 }),
			row({ model: "heavy", totalCost: 5, totalTokens: 1_000_000 }),
		])

		expect(cheapestPerMillionTokens?.model).toBe("heavy")
		expect(dearestPerMillionTokens?.model).toBe("light")
	})

	it("excludes rows with no token rate from the per-token ranking", () => {
		const { cheapestPerMillionTokens } = compareModelCosts([
			row({ model: "no-usage", totalTokens: 0, promptTokens: 0, completionTokens: 0 }),
			row({ model: "measured" }),
		])

		expect(cheapestPerMillionTokens?.model).toBe("measured")
	})
})

describe("compareModelCosts — totals and shares", () => {
	it("sums the period and derives its own rates", () => {
		const { totals } = compareModelCosts([
			row({ requests: 10, totalCost: 2, totalTokens: 1000 }),
			row({ requests: 30, totalCost: 6, totalTokens: 3000 }),
		])

		expect(totals.cost).toBeCloseTo(8, 10)
		expect(totals.requests).toBe(40)
		expect(totals.tokens).toBe(4000)
		expect(totals.costPerRequest).toBeCloseTo(0.2, 10)
		expect(totals.costPerMillionTokens).toBeCloseTo(2000, 10)
	})

	it("reports shares that add up to one", () => {
		const { rows } = compareModelCosts([row({ totalCost: 3 }), row({ totalCost: 1 })])

		expect(rows[0]?.shareOfCost).toBeCloseTo(0.75, 10)
		expect(rows.reduce((sum, r) => sum + r.shareOfCost, 0)).toBeCloseTo(1, 10)
	})

	it("answers zero shares for a period with no cost, rather than NaN", () => {
		const { rows, totals } = compareModelCosts([row({ totalCost: 0 })])

		expect(rows[0]?.shareOfCost).toBe(0)
		expect(totals.costPerRequest).toBe(0)
	})

	it("answers an empty comparison for an empty period", () => {
		const result = compareModelCosts([])

		expect(result.rows).toEqual([])
		expect(result.cheapestPerMillionTokens).toBeNull()
		expect(result.totals.cost).toBe(0)
	})

	it("drops a negative or non-finite cost instead of letting it cancel real spend", () => {
		const { totals } = compareModelCosts([
			row({ totalCost: -5 }),
			row({ totalCost: Number.NaN }),
			row({ totalCost: 2 }),
		])

		expect(totals.cost).toBeCloseTo(2, 10)
	})
})

describe("makeModelCostComparison", () => {
	it("reads the leaderboard with the caller's scope and reports its period", async () => {
		const calls: Array<Record<string, unknown>> = []
		const useCase = makeModelCostComparison({
			panels: {
				leaderboard: async (period: unknown, scope: unknown) => {
					calls.push({ period, scope })
					return {
						period: "7d",
						leaderboard: [
							{
								model: "m1",
								provider: "p1",
								requests: 10,
								successes: 10,
								successRate: "100.0",
								promptTokens: 10,
								completionTokens: 10,
								totalTokens: 20,
								avgTokensPerRequest: 2,
								totalCost: 1,
							},
						],
					}
				},
			} as never,
		})

		const scope = { apiKeyFilter: "key-1", allowedModels: "m*" }
		const answer = await useCase.comparison("7d", scope)

		expect(calls[0]).toEqual({ period: "7d", scope })
		expect(answer.period).toBe("7d")
		expect(answer.comparison.rows[0]?.model).toBe("m1")
	})
})
