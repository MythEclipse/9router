import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/** POST /api/tunnel/Tailscale enable — turn it on, then re-arm monitoring. */
export async function POST() {
	try {
		return NextResponse.json(await getUseCases().tunnel.tailscaleEnable())
	} catch (error) {
		console.error("Tunnel Tailscale enable error:", error)
		return failed(error, "Tailscale enable failed", "Error changing tunnel state")
	}
}
