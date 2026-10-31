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

/** GET /api/usage/pools - every budget pool with its verdict. */
export async function GET() {
	try {
		return NextResponse.json(await (await client()).usage.pools.list())
	} catch (error) {
		return failed(error, "Failed to read budget pools", "usage/pools")
	}
}

/**
 * POST /api/usage/pools - replace the whole list.
 *
 * Replacing rather than patching is what makes "a key belongs to one pool" checkable: a patch
 * would have to reason about a key moving between two documents.
 */
export async function POST(request: Request) {
	try {
		const body = await request.json().catch(() => ({}))
		return NextResponse.json(await (await client()).usage.pools.save(body as never))
	} catch (error) {
		return failed(error, "Failed to save budget pools", "usage/pools")
	}
}
