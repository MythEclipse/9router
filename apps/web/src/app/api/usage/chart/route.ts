/**
 * Usage chart series.
 *
 * Same router as the stats route, so both narrow to the caller the same way and a
 * refused period is refused identically. See `usage/stats/route.ts` for why the
 * 400 keeps the rule's wording.
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
		const period = new URL(request.url).searchParams.get("period") ?? undefined
		return NextResponse.json(await client.usage.chart({ period }))
	} catch (error) {
		if ((error as { code?: string })?.code === "VALIDATION") {
			return NextResponse.json({ error: (error as Error).message }, { status: 400 })
		}
		console.error("[API] Failed to get chart data:", error)
		return NextResponse.json({ error: "Failed to fetch chart data" }, { status: 500 })
	}
}
