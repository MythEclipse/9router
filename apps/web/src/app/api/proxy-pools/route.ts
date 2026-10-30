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

/** GET /api/proxy-pools - list, optionally filtered and with usage counts. */
export async function GET(request: Request) {
	try {
		const { searchParams } = new URL(request.url)
		return NextResponse.json(await (await client()).proxyPools.list(queryOf(searchParams)))
	} catch (error) {
		return failed(error, "Failed to fetch proxy pools", "Error fetching proxy pools")
	}
}

/** POST /api/proxy-pools - create one. 201: a pool exists that did not before. */
export async function POST(request: Request) {
	try {
		const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
		return NextResponse.json(await (await client()).proxyPools.create(body), { status: 201 })
	} catch (error) {
		return failed(error, "Failed to create proxy pool", "Error creating proxy pool")
	}
}
