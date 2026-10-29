import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { usageScopeOf } from "9router-api/application/usage/report-usage"
import { NextResponse } from "next/server"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * GET /api/usage/history?format=csv
 *
 * The CSV shaping, including quoting and formula defusing, is in
 * `domain/csv-export.ts`; this handler chooses the reply.
 */
export async function GET(request) {
	try {
		const { searchParams } = new URL(request.url)
		const ctx = await getSessionContext()
		const result = await getUseCases().usageReports.history(
			searchParams.get("format"),
			usageScopeOf(ctx),
		)

		if (result.kind === "csv") {
			return new NextResponse(result.body, {
				headers: {
					"Content-Type": "text/csv",
					"Content-Disposition": `attachment; filename="${result.filename}"`,
				},
			})
		}

		return NextResponse.json({ history: result.body })
	} catch (error) {
		console.error("Error fetching usage history:", error)
		return NextResponse.json({ error: "Failed to fetch usage history" }, { status: 500 })
	}
}
