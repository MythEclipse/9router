import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/** GET /api/tunnel/tailscale-check — what Tailscale looks like on this machine. */
export async function GET() {
	try {
		return NextResponse.json(await getUseCases().tunnel.tailscaleCheck())
	} catch (error) {
		console.error("Tailscale check error:", error)
		return failed(error, "Tailscale check failed", "Error checking Tailscale")
	}
}
