import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { usageScopeOf } from "9router-api/application/usage/report-usage"
import { NextResponse } from "next/server"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * GET /api/usage/sparks?period=30d
 * Compact per-day totals for the Overview card sparklines plus recent
 * session-scoped timestamps for the activity heatmap.
 */
export async function GET(request) {
	try {
		const { searchParams } = new URL(request.url)
		const ctx = await getSessionContext()
		const sparks = await getUseCases().usageReports.sparks(
			searchParams.get("period"),
			usageScopeOf(ctx),
		)
		return NextResponse.json(sparks)
	} catch (error) {
		if (error?.code === "VALIDATION") {
			return NextResponse.json({ error: error.message }, { status: 400 })
		}
		console.error("[API] Failed to get usage sparks:", error)
		return NextResponse.json({ error: "Failed to fetch usage sparks" }, { status: 500 })
	}
}
