import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { getAdapter } from "@9router/db/driver"
import { matchesAllowedModels, parseAllowedModels } from "@9router/db/repos/allowedModels"
import { isPeriodRefused, periodCutoff, resolvePeriod } from "9router-api/domain/reporting-period"
import {
	buildLeaderboard,
	type LeaderboardAggregateRow,
} from "9router-api/domain/usage-derivations"
import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

/**
 * GET /api/usage/leaderboard?period=7d
 *
 * Previously this handler did not validate the period at all — `?period=garbage` fell through
 * every branch to a 7-day cutoff and came back labelled `garbage`.
 *
 * The success count is now matching the error panel's rule (`LOWER(status)`), because the two
 * endpoints disagreed about a status stored as `"OK"`: a success here, an error there.
 */
export async function GET(request: Request) {
	try {
		const { searchParams } = new URL(request.url)
		const resolved = resolvePeriod(searchParams.get("period"))
		if (isPeriodRefused(resolved)) {
			return NextResponse.json({ error: resolved.message }, { status: 400 })
		}
		const period = resolved.period
		const cutoff = periodCutoff(period, new Date())

		const ctx = await getSessionContext()
		const patterns = parseAllowedModels(ctx.allowedModels || "*")

		const conds: string[] = []
		const params: unknown[] = []
		if (cutoff) {
			conds.push("timestamp >= ?")
			params.push(cutoff)
		}
		if (ctx.apiKeyFilter) {
			conds.push("apiKey = ?")
			params.push(ctx.apiKeyFilter)
		}
		const where = conds.length ? `WHERE ${conds.join(" AND ")}` : ""

		const db = await getAdapter()
		const rows = db.all<LeaderboardAggregateRow>(
			`SELECT model, provider,
              COUNT(*) as requests,
              SUM(CASE WHEN LOWER(status) IN ('ok','200','success') THEN 1 ELSE 0 END) as successes,
              SUM(promptTokens) as promptTokens,
              SUM(completionTokens) as completionTokens,
              SUM(promptTokens + completionTokens) as totalTokens,
              SUM(cost) as totalCost
       FROM usageHistory ${where}
       GROUP BY model ORDER BY requests DESC`,
			params,
		)

		const leaderboard = buildLeaderboard(rows, (model) => matchesAllowedModels(patterns, model))
		return NextResponse.json({ period, leaderboard })
	} catch (error) {
		console.error("Model leaderboard failed:", error)
		return NextResponse.json({ error: "Failed" }, { status: 500 })
	}
}
