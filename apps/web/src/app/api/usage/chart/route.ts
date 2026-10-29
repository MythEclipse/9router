import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { usageScopeOf } from "9router-api/application/usage/report-usage"
import { NextResponse } from "next/server"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

export async function GET(request) {
	try {
		const { searchParams } = new URL(request.url)
		const ctx = await getSessionContext()
		const data = await getUseCases().usageReports.chart(searchParams.get("period"), usageScopeOf(ctx))
		return NextResponse.json(data)
	} catch (error) {
		if (error?.code === "VALIDATION") {
			return NextResponse.json({ error: error.message }, { status: 400 })
		}
		console.error("[API] Failed to get chart data:", error)
		return NextResponse.json({ error: "Failed to fetch chart data" }, { status: 500 })
	}
}
