import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * POST /api/oauth/codex/import-token
 *
 * Takes a Codex access token, with the claims the dashboard needs read from it.
 * A token is proved against the provider before it is saved, so a bad one never becomes a
 * row the dashboard has to explain later.
 */
export async function POST(request: Request) {
	try {
		const result = await getUseCases().credentials.importToken("codex", await request.json())
		if (!result.ok) {
			return NextResponse.json({ error: result.error }, { status: result.status })
		}
		return NextResponse.json({ success: true, connection: result.connection })
	} catch (error) {
		return failed(error, "Codex import failed", "oauth/codex/import-token")
	}
}
