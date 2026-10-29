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
 * POST /api/headroom/stop - stop the managed Headroom proxy.
 *
 * Nothing to stop is 409, not 200: the caller asked for a state change that did not happen,
 * and answering 200 leaves the dashboard showing "stopped" for a proxy it never had. The
 * status arrives in the body because oRPC carries data, not status codes — this route is
 * where that becomes an HTTP answer.
 */
export async function POST() {
	try {
		const { status, ...body } = await (await client()).headroom.stop()
		return NextResponse.json(body, { status })
	} catch (error) {
		return failed(error, "Failed to stop Headroom", "headroom/stop")
	}
}
