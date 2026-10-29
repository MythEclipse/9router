import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/** GET /api/tunnel/status — both probes (cached for a few seconds), plus live download. */
export async function GET() {
	try {
		return NextResponse.json(await getUseCases().tunnel.status())
	} catch (error) {
		console.error("Tunnel status error:", error)
		return failed(error, "Tunnel status failed", "Error reading tunnel status")
	}
}
