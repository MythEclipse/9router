import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/** No-store: a progress poll must never be answered from a cache. */
const NO_STORE = { "Cache-Control": "no-store" }

/**
 * POST /api/proxy-pools/import-jobs — start a server-side bulk import.
 *
 * 202, not 200: the job has been accepted, not finished. The dashboard polls for progress
 * and survives the browser closing.
 */
export async function POST(request: Request) {
	try {
		const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
		if (!body) return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
		return NextResponse.json(await getUseCases().proxyPools.importJobs.start(body), {
			status: 202,
		})
	} catch (error) {
		return failed(error, "Could not start the import", "Error starting proxy import")
	}
}

/** GET /api/proxy-pools/import-jobs — one job by `?id=`, else the recent page. */
export async function GET(request: Request) {
	try {
		const { searchParams } = new URL(request.url)
		const result = await getUseCases().proxyPools.importJobs.read(searchParams)
		return NextResponse.json(result, { headers: NO_STORE })
	} catch (error) {
		return failed(error, "Could not read import jobs", "Error reading proxy import jobs")
	}
}

/** DELETE /api/proxy-pools/import-jobs?id= — ask a running job to stop. */
export async function DELETE(request: Request) {
	try {
		const { searchParams } = new URL(request.url)
		return NextResponse.json(await getUseCases().proxyPools.importJobs.cancel(searchParams))
	} catch (error) {
		return failed(error, "Could not cancel the import", "Error cancelling proxy import")
	}
}
