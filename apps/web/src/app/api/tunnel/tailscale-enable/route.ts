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
 * POST /api/tunnel/tailscale-enable
 *
 * Expose this install over Tailscale.
 */
export async function POST() {
	try {
		return NextResponse.json(await (await client()).tunnel.tailscale.enable())
	} catch (error) {
		return failed(error, "Failed to enable Tailscale", "tunnel/tailscale-enable")
	}
}
