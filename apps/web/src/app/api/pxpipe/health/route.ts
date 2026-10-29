import { NextResponse } from "next/server"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

export async function POST() {
	try {
		return NextResponse.json(await getUseCases().pxpipe.checkHealth())
	} catch (error) {
		// A failed probe is a result the card renders, not a 500: the panel needs
		// to show "unhealthy" rather than an error page.
		console.error("[API] pxpipe health check failed:", error)
		return NextResponse.json(
			{ healthy: false, checks: [], error: "pxpipe health check failed" },
			{ status: 500 },
		)
	}
}

// GET mirrors POST so the card can probe on page load without a mutation call.
export const GET = POST
