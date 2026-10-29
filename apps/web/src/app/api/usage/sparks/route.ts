/**
 * GET /api/usage/sparks?period=30d
 *
 * Compact per-day totals for the Overview card sparklines plus recent
 * session-scoped timestamps for the activity heatmap. Both come from the same
 * router as the other reads, so the period and the caller's scope are applied by
 * one rule rather than three.
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
		})
		const period = new URL(request.url).searchParams.get("period") ?? undefined
		return NextResponse.json(await client.usage.sparks({ period }))
	} catch (error) {
		if ((error as { code?: string })?.code === "VALIDATION") {
			return NextResponse.json({ error: (error as Error).message }, { status: 400 })
		}
		console.error("[API] Failed to get usage sparks:", error)
		return NextResponse.json({ error: "Failed to fetch usage sparks" }, { status: 500 })
	}
}
