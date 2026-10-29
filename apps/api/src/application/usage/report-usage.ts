/**
 * Usage reporting: the read-only dashboard endpoints.
 *
 * Six handlers repeated the same three steps — resolve the period, narrow the
 * session payload, call a repo helper — and each wrote them slightly
 * differently. They share this instead:
 *
 *   stats          period, key filter, model scope -> totals
 *   chart          period, key filter, model scope -> series
 *   sparks         period, key filter, model scope -> day totals
 *   history        key filter -> rows, optionally as CSV
 *   logs           the last N lines, no scope at all
 *   request-logs   identical to logs
 *
 * `logs` and `request-logs` were byte-identical apart from their error message,
 * so they are one use-case with one caller each. Their limit of 200 was a
 * literal in both; it is a named constant here.
 */

import { csvDocument } from "../../domain/csv-export.ts"
import { invalid } from "../../domain/errors.ts"
import {
	DEFAULT_PERIOD,
	DEFAULT_SPARKS_PERIOD,
	keyFilterOf,
	modelScopeOf,
	type ReportingPeriod,
	resolvePeriod,
} from "../../domain/reporting-period.ts"

/** How many recent lines the log views show. */
export const RECENT_LOG_LIMIT = 200

/** A usage row as the CSV export needs it. */
export interface UsageHistoryRow {
	readonly timestamp: string
	readonly provider?: string | null
	readonly model?: string | null
	readonly connectionId?: string | null
	readonly apiKeyMasked?: string | null
	readonly endpoint?: string | null
	readonly status?: string | null
	readonly cost?: number | null
	readonly tokens?: {
		readonly prompt_tokens?: number
		readonly input_tokens?: number
		readonly completion_tokens?: number
		readonly output_tokens?: number
	}
}

export interface UsageReportPort {
	stats(
		period: ReportingPeriod,
		apiKeyFilter: string | null,
		allowedModels: string,
	): Promise<unknown>
	chart(
		period: ReportingPeriod,
		apiKeyFilter: string | null,
		allowedModels: string,
	): Promise<unknown>
	sparks(
		period: ReportingPeriod,
		apiKeyFilter: string | null,
		allowedModels: string,
	): Promise<unknown>
	history(filter: { readonly apiKey?: string }): Promise<readonly UsageHistoryRow[]>
	recentLogs(limit: number): Promise<unknown>
}

/** The scope a session is allowed to read, narrowed from its payload. */
export interface UsageScope {
	readonly apiKeyFilter: string | null
	readonly allowedModels: string
}

export function usageScopeOf(
	session: {
		readonly apiKeyFilter?: unknown
		readonly allowedModels?: unknown
	} | null,
): UsageScope {
	return {
		apiKeyFilter: keyFilterOf(session?.apiKeyFilter),
		allowedModels: modelScopeOf(session?.allowedModels),
	}
}

const CSV_COLUMNS = [
	"timestamp",
	"provider",
	"model",
	"connectionId",
	"apiKeyMasked",
	"endpoint",
	"status",
	"cost",
	"promptTokens",
	"completionTokens",
] as const

/** A row in the export's column order. */
export function historyCsvRow(row: UsageHistoryRow): readonly unknown[] {
	return [
		row.timestamp,
		row.provider ?? "",
		row.model ?? "",
		row.connectionId ?? "",
		row.apiKeyMasked ?? "",
		row.endpoint ?? "",
		// An absent status is a success: the gateway only records a status when a
		// request failed, so a row without one completed.
		row.status || "ok",
		row.cost || 0,
		row.tokens?.prompt_tokens || row.tokens?.input_tokens || 0,
		row.tokens?.completion_tokens || row.tokens?.output_tokens || 0,
	]
}

/** The period a request asked for, or a refusal the boundary can surface. */
function requirePeriod(
	requested: unknown,
	fallback: ReportingPeriod = DEFAULT_PERIOD,
): ReportingPeriod {
	const resolved = resolvePeriod(requested, fallback)
	if (resolved.ok === false) throw invalid(resolved.message)
	return resolved.period
}

export function makeUsageReports(deps: { readonly usage: UsageReportPort }) {
	return {
		async stats(requestedPeriod: unknown, scope: UsageScope): Promise<unknown> {
			const period = requirePeriod(requestedPeriod)
			return deps.usage.stats(period, scope.apiKeyFilter, scope.allowedModels)
		},

		async chart(requestedPeriod: unknown, scope: UsageScope): Promise<unknown> {
			const period = requirePeriod(requestedPeriod)
			return deps.usage.chart(period, scope.apiKeyFilter, scope.allowedModels)
		},

		async sparks(requestedPeriod: unknown, scope: UsageScope): Promise<unknown> {
			// The sparkline card defaults to a month: a week of daily points does not
			// read as a line.
			const period = requirePeriod(requestedPeriod, DEFAULT_SPARKS_PERIOD)
			return deps.usage.sparks(period, scope.apiKeyFilter, scope.allowedModels)
		},

		async logs(): Promise<unknown> {
			return deps.usage.recentLogs(RECENT_LOG_LIMIT)
		},

		/**
		 * The export, as CSV text or the raw rows.
		 *
		 * `format` is a closed set: anything other than `csv` returns JSON, which is
		 * what the dashboard's fetch expects when it omits the parameter.
		 */
		async history(
			format: unknown,
			scope: UsageScope,
		): Promise<
			| { readonly kind: "csv"; readonly body: string; readonly filename: string }
			| { readonly kind: "json"; readonly body: readonly UsageHistoryRow[] }
		> {
			const filter: { apiKey?: string } = {}
			if (scope.apiKeyFilter !== null) filter.apiKey = scope.apiKeyFilter
			const rows = await deps.usage.history(filter)

			if (format !== "csv") return { kind: "json", body: rows }

			return {
				kind: "csv",
				body: csvDocument(CSV_COLUMNS, rows.map(historyCsvRow)),
				// One filename rule, so two downloads a second apart cannot collide.
				filename: `usage-report-${new Date().toISOString().slice(0, 10)}.csv`,
			}
		},
	}
}
