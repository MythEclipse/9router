import { NextResponse } from "next/server"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * The last request-logs lines. `/api/usage/logs` and `/api/usage/request-logs` were
 * byte-identical handlers apart from their error message, and both callers are
 * live; they now share one use-case.
 */
export async function GET() {
	try {
		const logs = await getUseCases().usageReports.logs()
		return NextResponse.json(logs)
	} catch (error) {
		console.error("[API ERROR] /api/usage/request-logs failed:", error)
		return NextResponse.json({ error: "Failed to fetch logs" }, { status: 500 })
	}
}
