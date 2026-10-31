/**
 * The spend-projection use-case: read the daily series, hand it to the projection rule.
 *
 * The series comes from the same port the sparkline card uses (`usage.sparks`), so the
 * forecast and the card above it can never disagree about what a day cost — they are the same
 * rows, narrowed by the same session scope. A second query with its own scope rules is how a
 * dashboard ends up showing a rate that does not match the totals next to it.
 *
 * The payload is narrowed here rather than trusted. `sparks` is supplied by the host, and a
 * host that returns a shape without a cost series is a wiring fault — answering "0 spent" for
 * it would be a wrong answer presented as a right one, which is the defect this codebase keeps
 * removing.
 */
import { AppError } from "../../domain/errors.ts"
import {
	DEFAULT_SPARKS_PERIOD,
	isPeriodRefused,
	type ReportingPeriod,
	resolvePeriod,
} from "../../domain/reporting-period.ts"
import { projectSpend, type SpendForecast } from "../../domain/spend-forecast.ts"
import type { UsageReportPort, UsageScope } from "./report-usage.ts"

/** The daily cost series as the sparkline port returns it. */
interface SparksPayload {
	readonly totals?: { readonly cost?: unknown } | null
}

/**
 * The cost series from a sparks payload, or `null` when it is not there.
 *
 * A non-array `cost` is not an empty series: an empty series means "no traffic yet" and is a
 * legitimate answer, while a missing one means the host and this use-case disagree about the
 * shape. Collapsing the two would hide a broken wiring behind a plausible zero.
 */
function costSeriesOf(payload: unknown): readonly unknown[] | null {
	if (payload === null || typeof payload !== "object") return null
	const { totals } = payload as SparksPayload
	if (totals === null || typeof totals !== "object") return null
	return Array.isArray(totals.cost) ? totals.cost : null
}

export interface SpendForecastResult {
	readonly period: ReportingPeriod
	readonly forecast: SpendForecast
}

export interface SpendForecastUseCase {
	readonly forecast: (
		period: unknown,
		scope: UsageScope,
		budgetCap?: number | null,
	) => Promise<SpendForecastResult>
}

export function makeSpendForecast(deps: { readonly usage: UsageReportPort }): SpendForecastUseCase {
	return {
		/**
		 * Project the period's spend, and — when a cap is supplied — when it runs out.
		 *
		 * The cap is an input rather than a lookup because the caller already holds it: the key
		 * table renders the same cap from `keyBudget`. Reading it a second time here would give
		 * the projection a second opinion about a number the page is already displaying.
		 */
		async forecast(
			requestedPeriod: unknown,
			scope: UsageScope,
			budgetCap: number | null = null,
		): Promise<SpendForecastResult> {
			const resolved = resolvePeriod(requestedPeriod, DEFAULT_SPARKS_PERIOD)
			if (isPeriodRefused(resolved)) {
				throw new AppError("VALIDATION", resolved.message, { status: 400 })
			}
			const payload = await deps.usage.sparks(resolved.period, scope.apiKeyFilter, scope.allowedModels)
			const dailyCost = costSeriesOf(payload)
			if (dailyCost === null) {
				throw new AppError("INTERNAL", "usage sparks did not carry a cost series")
			}
			return {
				period: resolved.period,
				forecast: projectSpend({
					dailyCost,
					now: new Date(),
					horizonDays: dailyCost.length,
					budgetCap,
				}),
			}
		},
	}
}
