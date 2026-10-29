/**
 * GET /api/usage/history?format=csv
 *
 * The CSV shaping, including quoting and formula defusing, is in
 * `domain/csv-export.ts`; this handler chooses the reply. The use-case returns a
 * discriminated result — `csv` carries a body and a filename, anything else is a
 * JSON payload — so the two shapes stay distinguishable instead of being sniffed
 * from the string.
 */
import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
	try {
		const client = createApiClient({
			session: sessionClaimsOf(await getSessionContext()),
			useCases: getUseCases(),
			headers: request.headers,
		})
		const format = new URL(request.url).searchParams.get("format") ?? undefined
		const result = await client.usage.history({ format })

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
