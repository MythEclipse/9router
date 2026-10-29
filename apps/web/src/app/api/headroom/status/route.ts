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

/** GET /api/headroom/status - installed, running, and the pid this install manages. */
export async function GET() {
	try {
		return NextResponse.json(await (await client()).headroom.status())
	} catch (error) {
		return failed(error, "Failed to read Headroom status", "headroom/status")
	}
}
