import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * Every CLI tool's status in one round-trip.
 *
 * The alternative was nineteen fetches from the browser, which is what this endpoint exists to
 * avoid. A tool whose status cannot be read is `null` here rather than missing, so the screen
 * can still render its row and say that one row failed to load.
 */
export async function GET(request: Request) {
	const client = createApiClient({
		session: sessionClaimsOf(await getSessionContext()),
		useCases: getUseCases(),
		headers: request.headers,
	})
	const answer = await client.cliTools.allStatuses()
	return NextResponse.json(answer.body, { status: answer.status })
}
