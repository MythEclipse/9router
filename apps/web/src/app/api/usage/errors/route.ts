import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { getAdapter } from "@9router/db/driver"
import { matchesAllowedModels, parseAllowedModels } from "@9router/db/repos/allowedModels"
import { isPeriodRefused, periodCutoff, resolvePeriod } from "9router-api/domain/reporting-period"
import { classifyErrors, type ErrorAggregateRow } from "9router-api/domain/usage-derivations"
import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

/**
 * GET /api/usage/errors?period=7d
 *
 * The cutoff comes from `periodCutoff` and the folding from `classifyErrors`, so this handler
 * only queries and answers. An unusable period is a 400 rather than a silent week of data —
 * the previous `PERIOD_MS[period] || PERIOD_MS["7d"]` made `?period=garbage` look correct.
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
		const rows = db.all<ErrorAggregateRow>(
			`SELECT status, model, COUNT(*) as count,
        SUM(promptTokens + completionTokens) as totalTokens
       FROM usageHistory
       ${where}
       GROUP BY status, model ORDER BY count DESC`,
			params,
		)

		const classified = classifyErrors(rows, (model) => matchesAllowedModels(patterns, model))
		return NextResponse.json({ period, ...classified })
	} catch (error) {
		console.error("Error classification failed:", error)
		return NextResponse.json({ error: "Failed" }, { status: 500 })
	}
}
