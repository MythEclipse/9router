import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * POST /api/oauth/zed/import
 *
 * Takes a Zed session, typically the one the IDE's keyring already holds.
 * A token is proved against the provider before it is saved, so a bad one never becomes a
 * row the dashboard has to explain later.
 */
export async function POST(request: Request) {
	try {
		const result = await getUseCases().credentials.importToken("zed", await request.json())
		if (!result.ok) {
			return NextResponse.json({ error: result.error }, { status: result.status })
		}
		return NextResponse.json({ success: true, connection: result.connection })
	} catch (error) {
		return failed(error, "Zed import failed", "oauth/zed/import")
	}
}
