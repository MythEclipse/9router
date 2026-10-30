import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * The Cowork MCP registry.
 *
 * `?refresh=1` skips the freshness check but not the fetch: a forced refresh that fails still
 * reports the error, and still leaves the cached list in place for the next screen that asks.
 * The cache itself lives in the host, one per process, because several screens ask for this and
 * the registry is a paginated third party.
 */
export async function GET(request: Request) {
	const client = createApiClient({
		session: sessionClaimsOf(await getSessionContext()),
		useCases: getUseCases(),
		headers: request.headers,
	})
	const refresh = new URL(request.url).searchParams.get("refresh") === "1"
	const answer = await client.coworkMcp.readRegistry({ refresh })
	return NextResponse.json(answer.body, { status: answer.status })
}
