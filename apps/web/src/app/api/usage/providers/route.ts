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

/**
 * GET /api/usage/providers - the providers the usage filter may offer this session.
 *
 * Narrowed to providers that served one of the caller's allowed models, so the filter cannot
 * be used to enumerate unrelated providers. The distinct-value query stays in SQL.
 */
export async function GET() {
	try {
		return NextResponse.json(await (await client()).usage.providers())
	} catch (error) {
		return failed(error, "Failed to fetch usage providers", "usage/providers")
	}
}
