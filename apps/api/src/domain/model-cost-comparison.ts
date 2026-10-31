/**
 * Cost per model, expressed in the units a decision is actually made in.
 *
 * The leaderboard already answers "what did this model cost". That is not the question anyone
 * asks: a total is a function of how often a model was *used*, so the cheapest model on the
 * page can be the one with the highest total. This module converts totals into rates, and
 * refuses the two divisions that produce a plausible-looking wrong answer:
 *
 * 1. **A model with no requests has no cost per request.** `0 / 0` is `NaN` and `x / 0` is
 *    `Infinity`; JSON turns the first into `null` and the second into `null` too, so the UI
 *    cannot tell "free" from "not measured". Both rates answer `null` explicitly.
 * 2. **A model that billed cost but reported no tokens** (an upstream that omits usage) has no
 *    cost per token. Reporting `0` there would put it at the top of a "cheapest per token"
 *    list it never earned.
 *
 * Shares are computed against the period total, and a period with no cost at all reports a
 * share of `0` for every row rather than `NaN`.
 */

/** One leaderboard entry, as the usage domain emits it. */
export interface ModelCostInput {
	readonly model: string
	readonly provider?: string
	readonly requests?: number
	readonly totalCost?: number
	readonly promptTokens?: number
	readonly completionTokens?: number
	readonly totalTokens?: number
}

export interface ComparedModel {
	readonly model: string
	readonly provider: string
	readonly requests: number
	readonly cost: number
	readonly tokens: number
	/** Cost per request, or `null` when the model served none. */
	readonly costPerRequest: number | null
	/** Cost per million tokens, or `null` when the model reported no tokens. */
	readonly costPerMillionTokens: number | null
	/** This model's fraction of the period's cost, in `[0, 1]`. */
	readonly shareOfCost: number
}

export interface ModelCostComparison {
	readonly rows: readonly ComparedModel[]
	readonly totals: {
		readonly requests: number
		readonly cost: number
		readonly tokens: number
		readonly costPerRequest: number | null
		readonly costPerMillionTokens: number | null
	}
	/** The cheapest row that reported tokens — the only rows a per-token rate can rank. */
	readonly cheapestPerMillionTokens: ComparedModel | null
	/** The dearest row that reported tokens. */
	readonly dearestPerMillionTokens: ComparedModel | null
}

/** A finite, non-negative number, or zero. */
function amountOf(value: unknown): number {
	const amount = typeof value === "number" ? value : Number(value)
	return Number.isFinite(amount) && amount > 0 ? amount : 0
}

/** A rate, or `null` when its denominator cannot support one. */
function rateOf(numerator: number, denominator: number, scale = 1): number | null {
	if (!Number.isFinite(denominator) || denominator <= 0) return null
	return (numerator / denominator) * scale
}

/**
 * Rank the period's models by what they cost to run, not by what they cost in total.
 *
 * Rows are ordered by cost descending — the order an operator triaging spend wants — and the
 * per-token extremes are reported separately because they answer a different question.
 */
export function compareModelCosts(entries: readonly ModelCostInput[]): ModelCostComparison {
	const totalCost = entries.reduce((sum, entry) => sum + amountOf(entry.totalCost), 0)
	const totalRequests = entries.reduce((sum, entry) => sum + amountOf(entry.requests), 0)
	const totalTokens = entries.reduce(
		(sum, entry) =>
			sum +
			(amountOf(entry.totalTokens) || amountOf(entry.promptTokens) + amountOf(entry.completionTokens)),
		0,
	)

	const rows = entries
		.map((entry): ComparedModel => {
			const requests = amountOf(entry.requests)
			const cost = amountOf(entry.totalCost)
			const tokens =
				amountOf(entry.totalTokens) || amountOf(entry.promptTokens) + amountOf(entry.completionTokens)
			return {
				model: entry.model,
				provider: entry.provider ?? "",
				requests,
				cost,
				tokens,
				costPerRequest: rateOf(cost, requests),
				costPerMillionTokens: rateOf(cost, tokens, 1_000_000),
				shareOfCost: totalCost > 0 ? cost / totalCost : 0,
			}
		})
		.sort((a, b) => b.cost - a.cost || b.requests - a.requests)

	const ranked = rows.filter((row) => row.costPerMillionTokens !== null)

	return {
		rows,
		totals: {
			requests: totalRequests,
			cost: totalCost,
			tokens: totalTokens,
			costPerRequest: rateOf(totalCost, totalRequests),
			costPerMillionTokens: rateOf(totalCost, totalTokens, 1_000_000),
		},
		cheapestPerMillionTokens:
			ranked.length > 0
				? ranked.reduce((best, row) =>
						(row.costPerMillionTokens ?? 0) < (best.costPerMillionTokens ?? 0) ? row : best,
					)
				: null,
		dearestPerMillionTokens:
			ranked.length > 0
				? ranked.reduce((worst, row) =>
						(row.costPerMillionTokens ?? 0) > (worst.costPerMillionTokens ?? 0) ? row : worst,
					)
				: null,
	}
}
