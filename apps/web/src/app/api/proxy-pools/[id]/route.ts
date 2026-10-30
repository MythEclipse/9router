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

const idOf = async (context: { params: Promise<{ id: string }> }) => (await context.params).id

/** GET /api/proxy-pools/[id] - read one. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
	try {
		return NextResponse.json(await (await client()).proxyPools.read({ id: await idOf(context) }))
	} catch (error) {
		return failed(error, "Failed to fetch proxy pool", "Error fetching proxy pool")
	}
}

/** PUT /api/proxy-pools/[id] - update the fields that were sent. */
export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
	try {
		const patch = (await request.json().catch(() => ({}))) as Record<string, unknown>
		return NextResponse.json(
			await (await client()).proxyPools.update({ id: await idOf(context), patch }),
		)
	} catch (error) {
		return failed(error, "Failed to update proxy pool", "Error updating proxy pool")
	}
}

/**
 * DELETE /api/proxy-pools/[id] - remove one, unless a connection still needs it.
 *
 * The 409 carries how many connections are in the way, so the screen can name them; the
 * mapping from `PoolInUseError` to that status is the boundary's, not the use-case's.
 */
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
	try {
		return NextResponse.json(await (await client()).proxyPools.remove({ id: await idOf(context) }))
	} catch (error) {
		return failed(error, "Failed to delete proxy pool", "Error deleting proxy pool")
	}
}
