/**
 * Usage statistics for the dashboard.
 *
 * Served through the oRPC router so this route and the `usage.stats` procedure
 * cannot answer differently — the period rule and the scope rule are one
 * implementation, not two.
 *
 * The period arrives as `?period=`, and a refused one is still 400 carrying the
 * rule's own wording: the dashboard shows that message to the user, so replacing it
 * with a generic failure would be a regression the type checker cannot see.
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
		return NextResponse.json(await client.usage.stats({ period }))
	} catch (error) {
		// A refused period is the caller's fault; the rule already worded the message.
		if ((error as { code?: string })?.code === "VALIDATION") {
			return NextResponse.json({ error: (error as Error).message }, { status: 400 })
		}
		console.error("[API] Failed to get usage stats:", error)
		return NextResponse.json({ error: "Failed to fetch usage stats" }, { status: 500 })
	}
}
