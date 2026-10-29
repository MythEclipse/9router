/**
 * The last logs lines. `/api/usage/logs` and `/api/usage/request-logs` were
 * byte-identical handlers apart from their error message, and both callers are
 * live; they now share one use-case — and this route reaches it through the same
 * router the other usage reads use.
 *
 * No scope argument: the procedure takes none, because these are the gateway's own
 * log lines rather than a per-key report.
 */
import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

export async function GET() {
	try {
		const client = createApiClient({
			session: sessionClaimsOf(await getSessionContext()),
			useCases: getUseCases(),
		})
		return NextResponse.json(await client.usage.logs())
	} catch (error) {
		console.error("[API ERROR] /api/usage/logs failed:", error)
		return NextResponse.json({ error: "Failed to fetch logs" }, { status: 500 })
	}
}
