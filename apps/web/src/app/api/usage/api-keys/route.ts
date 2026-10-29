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
 * GET /api/usage/api-keys - one row per API key: quota state plus aggregates.
 *
 * The five aggregate queries, the visibility rule, the quota window and the synthetic
 * "Deleted keys" row all live in the use-case now. The route answers the same payload it
 * always did; what it no longer does is decide who sees which key.
 */
export async function GET() {
	try {
		return NextResponse.json(await (await client()).usage.apiKeys())
	} catch (error) {
		return failed(error, "Failed to fetch API key usage", "usage/api-keys")
	}
}
