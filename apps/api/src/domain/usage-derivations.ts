/**
 * The usage tab's derived figures: error classification and the model leaderboard.
 *
 * Both endpoints ran the same two mistakes, and neither is visible in the reply:
 *
 * 1. **A silently substituted period.** `errors` had its own `PERIOD_MS` table and fell
 *    back to `7d` for anything unrecognised; `leaderboard` did not check the value at all.
 *    `?period=garbage` returned a week of data that looked exactly like a correct answer,
 *    labelled with the period the caller asked for. Both now go through
 *    `domain/reporting-period.ts`, which refuses it at the boundary.
 *
 * 2. **Success counted as an error, or errors counted as success.** `errors` tested statuses
 *    case-insensitively against `ok|success|200`, while the leaderboard counted successes
 *    with SQL `IN ('ok','200','success')` — case-sensitive, so a row storing `"OK"` counted
 *    as a success in one endpoint and an error in the other. `isSuccessStatus` decides it
 *    once for both.
 */

/** Statuses that mean the request succeeded. Compared case-insensitively, once. */
const SUCCESS_STATUSES = new Set(["ok", "success", "200"])

export function isSuccessStatus(status: unknown): boolean {
	// An absent status means the gateway recorded a success: it only records a status
	// when something went wrong.
	if (status == null || status === "") return true
	return SUCCESS_STATUSES.has(String(status).trim().toLowerCase())
}

/** Rows each table shows before it stops being readable. */
export const TOP_ERROR_MODEL_LIMIT = 20
export const LEADERBOARD_MODEL_LIMIT = 50

/** One `(status, model)` aggregate row as the store returns it. */
export interface ErrorAggregateRow {
	readonly status?: unknown
	readonly model?: unknown
	readonly count?: unknown
	readonly totalTokens?: unknown
}

export interface ErrorClassification {
	readonly total: number
	readonly errors: number
	/** Percent with one decimal, as a string: the UI prints it verbatim. */
	readonly errorRate: string
	readonly byStatus: Record<string, { count: number; totalTokens: number }>
	readonly topErrorModels: Array<{ model: string; errors: number; totalTokens: number }>
}

/**
 * Folds `(status, model)` rows into the error panel's shape.
 *
 * `total` counts every request in scope, successes included, because an error rate without
 * its denominator is meaningless. Rows outside the session's allowed models are dropped
 * *before* counting: including them in `total` while excluding them from `errors` would
 * understate the rate for a restricted key.
 */
export function classifyErrors(
	rows: readonly ErrorAggregateRow[],
	isAllowedModel: (model: string) => boolean,
): ErrorClassification {
	const byStatus: Record<string, { count: number; totalTokens: number }> = {}
	const byModel: Record<string, { errors: number; totalTokens: number }> = {}
	let total = 0
	let errors = 0

	for (const row of rows) {
		const model = typeof row.model === "string" ? row.model : ""
		if (!isAllowedModel(model)) continue

		const status = row.status == null || row.status === "" ? "ok" : String(row.status).trim()
		const count = Number(row.count) || 0
		const tokens = Number(row.totalTokens) || 0
		total += count

		if (isSuccessStatus(status)) continue

		errors += count
		const statusRow = (byStatus[status] ??= { count: 0, totalTokens: 0 })
		statusRow.count += count
		statusRow.totalTokens += tokens

		const modelRow = (byModel[model || "unknown"] ??= { errors: 0, totalTokens: 0 })
		modelRow.errors += count
		modelRow.totalTokens += tokens
	}

	return {
		total,
		errors,
		errorRate: formatPercent(errors, total),
		byStatus,
		topErrorModels: Object.entries(byModel)
			.sort((a, b) => b[1].errors - a[1].errors)
			.slice(0, TOP_ERROR_MODEL_LIMIT)
			.map(([model, data]) => ({ model, ...data })),
	}
}

/**
 * A percentage with one decimal, as the UI prints it directly.
 *
 * Zero traffic reports "0.0" rather than the `NaN` the division produces, which would
 * render as a literal "NaN%" in the rate badge.
 */
export function formatPercent(part: number, whole: number): string {
	if (!Number.isFinite(whole) || whole <= 0) return "0.0"
	return ((part / whole) * 100).toFixed(1)
}

/** One `(model, provider)` aggregate row as the store returns it. */
export interface LeaderboardAggregateRow {
	readonly model?: unknown
	readonly provider?: unknown
	readonly requests?: unknown
	readonly successes?: unknown
	readonly promptTokens?: unknown
	readonly completionTokens?: unknown
	readonly totalTokens?: unknown
	readonly totalCost?: unknown
}

export interface LeaderboardEntry {
	readonly model: string
	readonly provider: string
	readonly requests: number
	readonly successes: number
	readonly successRate: string
	readonly promptTokens: number
	readonly completionTokens: number
	readonly totalTokens: number
	readonly avgTokensPerRequest: number
	readonly totalCost: number
}

/**
 * Builds the leaderboard rows.
 *
 * Ordered by request count because the table's question is "what is being used", and cut to
 * `LEADERBOARD_MODEL_LIMIT` *after* filtering by allowed models — slicing first would leave
 * a restricted session with fewer rows than it is entitled to.
 */
export function buildLeaderboard(
	rows: readonly LeaderboardAggregateRow[],
	isAllowedModel: (model: string) => boolean,
): LeaderboardEntry[] {
	return rows
		.filter((row) => typeof row.model === "string" && row.model !== "" && isAllowedModel(row.model))
		.map((row) => {
			const requests = Number(row.requests) || 0
			const successes = Number(row.successes) || 0
			const totalTokens = Number(row.totalTokens) || 0
			return {
				model: String(row.model),
				provider: typeof row.provider === "string" ? row.provider : "",
				requests,
				successes,
				successRate: formatPercent(successes, requests),
				promptTokens: Number(row.promptTokens) || 0,
				completionTokens: Number(row.completionTokens) || 0,
				totalTokens,
				// A model with no requests has no average; 0 is honest, NaN is a bug.
				avgTokensPerRequest: requests > 0 ? Math.round(totalTokens / requests) : 0,
				totalCost: Number(row.totalCost) || 0,
			}
		})
		.sort((a, b) => b.requests - a.requests)
		.slice(0, LEADERBOARD_MODEL_LIMIT)
}
