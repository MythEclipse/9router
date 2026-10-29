import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/** POST /api/tunnel/Cloudflare tunnel enable — turn it on, then re-arm monitoring. */
export async function POST() {
	try {
		return NextResponse.json(await getUseCases().tunnel.enable())
	} catch (error) {
		console.error("Tunnel Cloudflare tunnel enable error:", error)
		return failed(error, "Cloudflare tunnel enable failed", "Error changing tunnel state")
	}
}
