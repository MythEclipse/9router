import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/** POST /api/tunnel/Cloudflare tunnel disable — turn it on, then re-arm monitoring. */
export async function POST() {
	try {
		return NextResponse.json(await getUseCases().tunnel.disable())
	} catch (error) {
		console.error("Tunnel Cloudflare tunnel disable error:", error)
		return failed(error, "Cloudflare tunnel disable failed", "Error changing tunnel state")
	}
}
