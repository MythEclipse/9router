/**
 * Spend projection: what the current rate says the rest of the window will cost.
 *
 * The dashboard can already say what was spent. It cannot say what is *about to be* spent,
 * which is the only question a budget actually answers — "will this key survive the month"
 * is unanswerable from a total. Three ways that arithmetic goes quietly wrong, and the shape
 * below exists to refuse all three:
 *
 * 1. **A partial day enters the average.** Today has run for four hours and holds a sixth of
 *    a day's cost. Averaged with six complete days it drags the daily rate down, and every
 *    projection built on that rate is understated — a budget that looks safe reads unsafe one
 *    day later. The partial day is extrapolated to a full day *before* it joins the mean, and
 *    the raw figure stays available as `todaySoFar` so "spent today" never shows the
 *    extrapolation.
 *
 * 2. **Zero traffic divides by zero.** A fresh install has no history, so `remaining / rate`
 *    is `Infinity`, and `Infinity` serialises to `null` in JSON — the budget card would then
 *    read the same for "never exhausts" and "no data at all". A zero rate answers `null` for
 *    the ETA and `"none"` for confidence; the caller can tell the two apart.
 *
 * 3. **Junk in the rollup becomes a forecast.** `usageDaily` holds JSON written by the
 *    gateway, so a row from a half-migrated database can carry `null` or a negative cost.
 *    Non-finite and negative values count as zero for their day: a negative spend would
 *    otherwise cancel real spend and project a total below what has already been spent.
 *
 * The extrapolation of today is capped at 24 hours of observed rate. Just after midnight the
 * elapsed fraction is a few seconds, and an uncapped `so_far / elapsed` turns one request into
 * a day's spend — the cap makes the worst case "we assume the rest of today looks like now",
 * which is wrong in a direction a reader can reason about.
 */

/** Days of complete history a projection needs before it is worth acting on. */
export const FORECAST_MIN_HISTORY_DAYS = 3

/** The floor on the elapsed fraction of today: no extrapolating more than 24x. */
const MIN_ELAPSED_DAY_FRACTION = 1 / 24

/** Milliseconds in a day, named because the rate arithmetic reads it twice. */
const DAY_MS = 86_400_000

export type ForecastConfidence = "none" | "thin" | "ok"

export interface SpendForecastInput {
	/** One entry per day, oldest first, the last entry being today (partial). */
	readonly dailyCost: readonly unknown[]
	/** The instant the projection starts from. Passed in so the answer is testable. */
	readonly now: Date
	/** Days the projection covers, counting today. Defaults to the series length. */
	readonly horizonDays?: number
	/** The cap to measure exhaustion against, in the same unit as `dailyCost`. */
	readonly budgetCap?: number | null
}

export interface SpendForecast {
	/** Complete days behind the projection, excluding today. */
	readonly historyDays: number
	/** Everything the series holds, junk dropped. */
	readonly observedSpend: number
	readonly todaySoFar: number
	/** Today extrapolated to a full day. */
	readonly todayProjected: number
	/** Cost per day at the current rate. Zero when there is nothing to extrapolate. */
	readonly dailyRate: number
	readonly horizonDays: number
	/** Spend for the whole horizon: history, today's projection, and the days still to come. */
	readonly projectedTotal: number
	readonly budgetCap: number | null
	/** Cap minus what has actually been spent. Negative once the cap is passed. */
	readonly budgetRemaining: number | null
	/** Projected total minus cap. Negative means the window closes under budget. */
	readonly projectedOverspend: number | null
	readonly hoursToExhaustion: number | null
	readonly exhaustedAt: string | null
	readonly confidence: ForecastConfidence
}

/** A stored cost, or zero when the row cannot be trusted. */
function costOf(value: unknown): number {
	const cost = typeof value === "number" ? value : Number(value)
	return Number.isFinite(cost) && cost > 0 ? cost : 0
}

/** A cap the caller supplied, or `null` when it is absent or unusable. */
function capOf(value: number | null | undefined): number | null {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null
	return value
}

/**
 * How much of the current local day has passed, in `[1/24, 1]`.
 *
 * Local, not UTC: the day buckets in `usageDaily` are local-day buckets, so a UTC fraction
 * would extrapolate a local day against a UTC clock and be wrong by the offset.
 */
export function elapsedDayFraction(now: Date): number {
	const elapsedMs = now.getHours() * 3_600_000 + now.getMinutes() * 60_000 + now.getSeconds() * 1_000
	const fraction = elapsedMs / DAY_MS
	return Math.min(1, Math.max(MIN_ELAPSED_DAY_FRACTION, fraction))
}

/**
 * Cost per day, from the complete days plus today's projection.
 *
 * Today is included because excluding it throws away the freshest evidence, and a rate built
 * only on old days answers a question about last week. With no complete day at all, today's
 * projection is the only estimate available — which is why it is reported as `"thin"`.
 */
function dailyRateOf(
	history: readonly number[],
	todayProjected: number,
	hasToday: boolean,
): number {
	if (history.length === 0) return hasToday ? todayProjected : 0
	const complete = history.reduce((sum, cost) => sum + cost, 0)
	return (complete + todayProjected) / (history.length + 1)
}

function confidenceOf(historyDays: number, observedSpend: number): ForecastConfidence {
	if (historyDays === 0 && observedSpend === 0) return "none"
	if (historyDays < FORECAST_MIN_HISTORY_DAYS) return "thin"
	return "ok"
}

/**
 * Project the series forward.
 *
 * `horizonDays` counts today, so a caller reading a 30-day series asks for 30 and gets the
 * month-to-date total extrapolated to the month end, not a total that silently grows by a day
 * every time it is called.
 */
export function projectSpend(input: SpendForecastInput): SpendForecast {
	const series = input.dailyCost.map(costOf)
	const historyDays = Math.max(0, series.length - 1)
	const history = series.slice(0, historyDays)
	const todaySoFar = series.length > 0 ? series[series.length - 1] : 0
	const observedSpend = series.reduce((sum, cost) => sum + cost, 0)

	const todayProjected = todaySoFar / elapsedDayFraction(input.now)
	const dailyRate = dailyRateOf(history, todayProjected, series.length > 0)

	const horizonDays = Math.max(1, Math.trunc(input.horizonDays ?? (series.length || 1)))
	const daysAfterToday = Math.max(0, horizonDays - historyDays - 1)
	const projectedTotal =
		history.reduce((sum, cost) => sum + cost, 0) + todayProjected + dailyRate * daysAfterToday

	const budgetCap = capOf(input.budgetCap)
	const budgetRemaining = budgetCap === null ? null : budgetCap - observedSpend
	const projectedOverspend = budgetCap === null ? null : projectedTotal - budgetCap

	const hoursToExhaustion =
		budgetCap === null || dailyRate <= 0 || budgetRemaining === null
			? null
			: Math.max(0, budgetRemaining) / (dailyRate / 24)

	return {
		historyDays,
		observedSpend,
		todaySoFar,
		todayProjected,
		dailyRate,
		horizonDays,
		projectedTotal,
		budgetCap,
		budgetRemaining,
		projectedOverspend,
		hoursToExhaustion,
		exhaustedAt:
			hoursToExhaustion === null
				? null
				: new Date(input.now.getTime() + hoursToExhaustion * 3_600_000).toISOString(),
		confidence: confidenceOf(historyDays, observedSpend),
	}
}
