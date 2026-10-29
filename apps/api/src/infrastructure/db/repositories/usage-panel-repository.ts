/**
 * The error and leaderboard aggregate rows.
 *
 * Both used to build their `WHERE` clause by hand, three lines each, in the route — and the two
 * copies disagreed. `leaderboard` had no period validation at all, so `?period=garbage` cut off
 * at seven days and came back labelled `garbage`; the fix then had to be made twice, once per
 * route, and the second copy is never the one you remember. This module names the clause once.
 *
 * The scope is applied here *and* again in the use-case, deliberately: `usageHistory` stores the
 * provider's spelling of a model while the allow-list is written in the caller's, so a model can
 * pass SQL and fail the in-memory check (or the reverse). Narrowing in SQL keeps the row count
 * down; narrowing again in memory is what actually enforces the rule.
 */
import { getAdapter } from "@9router/db/driver"
import type { UsageScope } from "../../../application/usage/report-usage.ts"
import { periodCutoff, type ReportingPeriod } from "../../../domain/reporting-period.ts"

/** The condition both aggregates share: the period's cutoff and the caller's key. */
function whereClause(
	period: ReportingPeriod,
	now: Date,
	scope: UsageScope,
): { sql: string; params: unknown[] } {
	const conditions: string[] = []
	const params: unknown[] = []

	const cutoff = periodCutoff(period, now)
	if (cutoff) {
		conditions.push("timestamp >= ?")
		params.push(cutoff)
	}
	if (scope.apiKeyFilter) {
		conditions.push("apiKey = ?")
		params.push(scope.apiKeyFilter)
	}

	return { sql: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "", params }
}

export async function errorRows(input: {
	readonly period: ReportingPeriod
	readonly now: Date
	readonly scope: UsageScope
}): Promise<readonly unknown[]> {
	const db = await getAdapter()
	const where = whereClause(input.period, input.now, input.scope)
	// COUNT/SUM per (status, model): the classification needs the counts, not the rows, and
	// pulling every row to count them client-side is what made this endpoint slow on big installs.
	return db.all(
		`SELECT status, model, COUNT(*) as count,
		        SUM(promptTokens + completionTokens) as totalTokens
		   FROM usageHistory ${where.sql}
		  GROUP BY status, model ORDER BY count DESC`,
		where.params,
	)
}

export async function leaderboardRows(input: {
	readonly period: ReportingPeriod
	readonly now: Date
	readonly scope: UsageScope
}): Promise<readonly unknown[]> {
	const db = await getAdapter()
	const where = whereClause(input.period, input.now, input.scope)
	// `LOWER(status)` is the same rule the error panel classifies with, so a row stored as "OK"
	// counts as a success in both. The two endpoints disagreed about exactly that.
	return db.all(
		`SELECT model, provider,
		        COUNT(*) as requests,
		        SUM(CASE WHEN LOWER(status) IN ('ok','200','success') THEN 1 ELSE 0 END) as successes,
		        SUM(promptTokens) as promptTokens,
		        SUM(completionTokens) as completionTokens,
		        SUM(promptTokens + completionTokens) as totalTokens,
		        SUM(cost) as totalCost
		   FROM usageHistory ${where.sql}
		  GROUP BY model ORDER BY requests DESC`,
		where.params,
	)
}
