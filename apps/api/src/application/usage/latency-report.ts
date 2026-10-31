/**
 * The latency report: read the timed requests in a window, hand them to the percentile rule.
 *
 * The measurements come from `usageHistory`, which is the only table that holds one row per
 * request and survives the retention sweep. The alternative — reading `requestDetails`, where
 * the timings used to live — would answer only for the last few hundred requests and then
 * silently stop, which is worse than not answering at all.
 *
 * The scope is the caller's, not the install's: an API-key session sees its own traffic.
 * That is the same `UsageScope` the rest of the usage page applies, so the latency panel and
 * the totals beside it cannot disagree about whose requests they are counting.
 *
 * `limit` is a ceiling on how many rows a report may read, and it is applied in SQL. A busy
 * gateway can produce hundreds of thousands of rows in a month; loading them to compute a p95
 * would make the panel the heaviest query on the dashboard. When the ceiling is hit the
 * summary reports `truncated` so the reader knows the window is sampled from the newest end
 * rather than pretending it is complete.
 */
import { AppError } from "../../domain/errors.ts"
import { buildLatencyReport, type LatencyReport } from "../../domain/latency.ts"
import {
	DEFAULT_PERIOD,
	isPeriodRefused,
	periodCutoff,
	type ReportingPeriod,
	resolvePeriod,
} from "../../domain/reporting-period.ts"
import type { UsageScope } from "./report-usage.ts"

/** One timed request, as the store returns it. */
export interface LatencySampleRow {
	readonly timestamp: string
	readonly provider: string | null
	readonly model: string | null
	readonly latencyMs: number
	readonly ttftMs: number | null
	readonly cached: boolean
}

export interface LatencySampleRequest {
	readonly since: string
	readonly apiKey: string | null
	readonly allowedModels: string
	readonly limit: number
}

/** The storage this use-case needs: timed rows for a window. */
export interface LatencySamplePort {
	samples(request: LatencySampleRequest): Promise<readonly LatencySampleRow[]>
}

/** How many rows one report may read before it is considered a sample. */
export const LATENCY_ROW_CEILING = 20_000

export interface LatencyReportResult {
	readonly period: ReportingPeriod
	/** ISO instant the window starts at, or `null` for "everything". */
	readonly since: string | null
	readonly report: LatencyReport
	/** True when the row ceiling was reached, so the window is the newest rows only. */
	readonly truncated: boolean
	readonly rowCeiling: number
}

export interface LatencyReportUseCase {
	readonly report: (period: unknown, scope: UsageScope, now?: Date) => Promise<LatencyReportResult>
}

export function makeLatencyReport(deps: {
	readonly samples: LatencySamplePort
}): LatencyReportUseCase {
	return {
		async report(requestedPeriod: unknown, scope: UsageScope, now: Date = new Date()) {
			const resolved = resolvePeriod(requestedPeriod, DEFAULT_PERIOD)
			if (isPeriodRefused(resolved)) {
				throw new AppError("VALIDATION", resolved.message, { status: 400 })
			}
			const since = periodCutoff(resolved.period, now)
			const rows = await deps.samples.samples({
				// "all" has no cutoff. The epoch is used rather than an empty string so the
				// SQL comparison stays a single shape, and a row stamped in 1970 is not a
				// real possibility.
				since: since ?? new Date(0).toISOString(),
				apiKey: scope.apiKeyFilter,
				allowedModels: scope.allowedModels,
				limit: LATENCY_ROW_CEILING,
			})

			const measurements = rows.map((row) => ({
				provider: row.provider,
				model: row.model,
				latencyMs: row.latencyMs,
				ttftMs: row.ttftMs,
				cached: row.cached,
			}))

			return {
				period: resolved.period,
				since,
				report: buildLatencyReport(measurements),
				truncated: rows.length >= LATENCY_ROW_CEILING,
				rowCeiling: LATENCY_ROW_CEILING,
			}
		},
	}
}
