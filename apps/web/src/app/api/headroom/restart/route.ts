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
 * POST /api/headroom/restart - restart the local Headroom proxy.
 *
 * Same gate and same port rule as `start`: a "restart" of a proxy this install never started
 * is not a restart, so a remote URL is refused here too.
 */
export async function POST() {
	try {
		return NextResponse.json(await (await client()).headroom.restart())
	} catch (error) {
		return failed(error, "Failed to restart Headroom", "headroom/restart")
	}
}
