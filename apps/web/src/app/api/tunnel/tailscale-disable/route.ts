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
 * POST /api/tunnel/tailscale-disable
 *
 * Stop exposing it over Tailscale.
 */
export async function POST() {
	try {
		return NextResponse.json(await (await client()).tunnel.tailscale.disable())
	} catch (error) {
		return failed(error, "Failed to disable Tailscale", "tunnel/tailscale-disable")
	}
}
