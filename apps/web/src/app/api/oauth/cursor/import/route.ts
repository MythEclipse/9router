import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * POST /api/oauth/cursor/import
 *
 * Takes a Cursor access token and the machine id its client is identified by.
 * A token is proved against the provider before it is saved, so a bad one never becomes a
 * row the dashboard has to explain later.
 */
export async function POST(request: Request) {
	try {
		const result = await getUseCases().credentials.importToken("cursor", await request.json())
		if (!result.ok) {
			return NextResponse.json({ error: result.error }, { status: result.status })
		}
		return NextResponse.json({ success: true, connection: result.connection })
	} catch (error) {
		return failed(error, "Cursor import failed", "oauth/cursor/import")
	}
}
