import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { sessionRole } from "@/lib/sessionRole"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * GET /api/settings/history — the before-images of the last settings mutations.
 *
 * Part of the security trail: "what did this install look like just before that
 * change" is the question a revert asks first.
 */
export async function GET() {
	try {
		const role = await sessionRole()
		const { history, total } = await getUseCases().settingsHistory.list({ role })
		return NextResponse.json({ history, total }, { headers: { "Cache-Control": "no-store" } })
	} catch (error) {
		console.log("Error listing settings history:", error)
		return failed(error, "Failed to load settings history", "Error listing settings history")
	}
}

/**
 * POST /api/settings/history — one entry in full, so a revert can be previewed.
 *
 * A POST that reads is not a mistake: the id travels in the body so it stays out of
 * the URL, and the answer carries the whole configuration that entry would restore.
 */
export async function POST(request: Request) {
	try {
		const body = (await request.json().catch(() => ({}))) as { id?: unknown }
		const role = await sessionRole()
		const result = await getUseCases().settingsHistory.read({
			id: String(body?.id ?? ""),
			role,
		})
		return NextResponse.json(result)
	} catch (error) {
		console.log("Error reading settings history:", error)
		return failed(error, "Failed to read settings history", "Error reading settings history")
	}
}
