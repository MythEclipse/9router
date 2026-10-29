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

/** GET /api/tunnel/status - Cloudflare's tunnel state, Tailscale's, and the download link. */
export async function GET() {
	try {
		return NextResponse.json(await (await client()).tunnel.status())
	} catch (error) {
		return failed(error, "Failed to read tunnel status", "tunnel/status")
	}
}
