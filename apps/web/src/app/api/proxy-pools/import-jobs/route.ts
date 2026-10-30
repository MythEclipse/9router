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

/** No-store: a progress poll must never be answered from a cache. */
const NO_STORE = { "Cache-Control": "no-store" }

/**
 * POST /api/proxy-pools/import-jobs - start a server-side bulk import.
 *
 * 202, not 201: the job has been accepted, not finished. The dashboard polls for progress and
 * survives the browser closing.
 */
export async function POST(request: Request) {
	try {
		const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
		if (!body) return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
		return NextResponse.json(await (await client()).proxyPools.importJobs.start(body), {
			status: 202,
		})
	} catch (error) {
		return failed(error, "Could not start the import", "Error starting proxy import")
	}
}

/** GET /api/proxy-pools/import-jobs - one job by `?id=`, else the recent page. */
export async function GET(request: Request) {
	try {
		const { searchParams } = new URL(request.url)
		const result = await (await client()).proxyPools.importJobs.read(queryOf(searchParams))
		return NextResponse.json(result, { headers: NO_STORE })
	} catch (error) {
		return failed(error, "Could not read import jobs", "Error reading proxy import jobs")
	}
}

/** DELETE /api/proxy-pools/import-jobs?id= - ask a running job to stop. */
export async function DELETE(request: Request) {
	try {
		const { searchParams } = new URL(request.url)
		const id = searchParams.get("id")
		if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 })
		return NextResponse.json(await (await client()).proxyPools.importJobs.cancel({ id }))
	} catch (error) {
		return failed(error, "Could not cancel the import", "Error cancelling proxy import")
	}
}
