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
 * GET /api/tunnel/tailscale-check - installed, signed in, and what to do when not.
 *
 * A miss is not an error: "Tailscale is not installed" is a state the screen renders, with
 * the command to run.
 */
export async function GET() {
	try {
		return NextResponse.json(await (await client()).tunnel.tailscale.check())
	} catch (error) {
		return failed(error, "Failed to check Tailscale", "tunnel/tailscale-check")
	}
}
