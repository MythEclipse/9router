import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { usageScopeOf } from "9router-api/application/usage/report-usage"
import { NextResponse } from "next/server"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

export async function GET(request) {
	try {
		const { searchParams } = new URL(request.url)
		const ctx = await getSessionContext()
		const stats = await getUseCases().usageReports.stats(
			searchParams.get("period"),
			usageScopeOf(ctx),
		)
		return NextResponse.json(stats)
	} catch (error) {
		// A refused period is the caller's fault; the rule already worded the message.
		if (error?.code === "VALIDATION") {
			return NextResponse.json({ error: error.message }, { status: 400 })
		}
		console.error("[API] Failed to get usage stats:", error)
		return NextResponse.json({ error: "Failed to fetch usage stats" }, { status: 500 })
	}
}
