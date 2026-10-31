import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * GET /api/queue - the concurrency bound, its queue, and the retry-after it would hand out.
 *
 * Read-only and cheap: it reports counters the gate already keeps, so a dashboard can poll it
 * without touching the database.
 */
export async function GET() {
	try {
		const client = createApiClient({
			session: sessionClaimsOf(await getSessionContext()),
			useCases: getUseCases(),
			headers: new Headers(),
		})
		const status = await (await client).queue.status()

		return NextResponse.json(status, { headers: { "cache-control": "no-store" } })
	} catch (error) {
		return failed(error, "Failed to read the queue status", "queue")
	}
}
