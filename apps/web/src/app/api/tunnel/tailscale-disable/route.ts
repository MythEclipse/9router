import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/** POST /api/tunnel/Tailscale disable — turn it on, then re-arm monitoring. */
export async function POST() {
	try {
		return NextResponse.json(await getUseCases().tunnel.tailscaleDisable())
	} catch (error) {
		console.error("Tunnel Tailscale disable error:", error)
		return failed(error, "Tailscale disable failed", "Error changing tunnel state")
	}
}
