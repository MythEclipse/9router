import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { getChartData } from "@/lib/usageDb"

const VALID_PERIODS = new Set(["today", "24h", "7d", "30d", "60d", "all"])

export const dynamic = "force-dynamic"

export async function GET(request) {
	try {
		const { searchParams } = new URL(request.url)
		const period = searchParams.get("period") || "7d"

		if (!VALID_PERIODS.has(period)) {
			return NextResponse.json({ error: "Invalid period" }, { status: 400 })
		}

		const ctx = await getSessionContext()
		// Narrowed locally: getSessionContext types its session payload fields as
		// `unknown`, but the filter is a key string or null and the model scope is
		// always a string at this point.
		const apiKeyFilter = typeof ctx.apiKeyFilter === "string" ? ctx.apiKeyFilter : null
		const allowedModels = typeof ctx.allowedModels === "string" ? ctx.allowedModels : "*"
		const data = await getChartData(period, apiKeyFilter, allowedModels)
		return NextResponse.json(data)
	} catch (error) {
		console.error("[API] Failed to get chart data:", error)
		return NextResponse.json({ error: "Failed to fetch chart data" }, { status: 500 })
	}
}
