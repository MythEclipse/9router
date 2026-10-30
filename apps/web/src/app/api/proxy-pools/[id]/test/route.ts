import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

async function client() {
	return createApiClient({
		session: sessionClaimsOf(await getSessionContext()),
		useCases: getUseCases(),
		headers: new Headers(),
	})
}

/** The query as flat pairs the procedure accepts; the use-case rebuilds URLSearchParams. */
function queryOf(searchParams: URLSearchParams) {
	const query: Record<string, string> = {}
	for (const [key, value] of searchParams) query[key] = value
	return query
}

/**
 * POST /api/proxy-pools/[id]/test - prove the egress path works, and record the result.
 *
 * The write-back is in the use-case: a failing pool becomes inactive so the router stops
 * retrying a known-broken path, and `lastError` is cleared on success.
 */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
	try {
		const { id } = await context.params
		return NextResponse.json(await (await client()).proxyPools.test({ id }))
	} catch (error) {
		return failed(error, "Failed to test proxy pool", "Error testing proxy pool")
	}
}
