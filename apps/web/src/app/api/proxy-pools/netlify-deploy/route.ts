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
 * POST /api/proxy-pools/netlify-deploy - deploy a relay and register it as a pool.
 *
 * 201: the pool now exists. The four providers share one procedure because
 * `RELAY_CONTRACTS` already treats them as one shape - four handlers here would be four
 * copies and a fifth place to add the next provider.
 */
export async function POST(request: Request) {
	try {
		const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
		const result = await (await client()).proxyPools.deploy({ provider: "netlify", body })
		return NextResponse.json(result, { status: 201 })
	} catch (error) {
		return failed(error, "Deploy failed", "Error deploying netlify relay")
	}
}
