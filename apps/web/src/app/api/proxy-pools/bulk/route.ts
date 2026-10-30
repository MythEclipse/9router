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
 * DELETE /api/proxy-pools/bulk - { ids } or { all: true }.
 *
 * One statement, one transaction, one auth check. A per-id loop cost hundreds of round trips
 * and could not be cancelled without leaving a partial delete.
 */
export async function DELETE(request: Request) {
	try {
		const body = (await request.json().catch(() => ({}))) as {
			ids?: string[]
			all?: boolean
		}
		return NextResponse.json(await (await client()).proxyPools.bulkRemove(body))
	} catch (error) {
		return failed(error, "Failed to delete proxy pools", "Error bulk deleting proxy pools")
	}
}
