import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * POST /api/oauth/xiaomi-mimo/api-key
 *
 * Imports a MiMo key, or a session that has no key at all. A re-import of the same
 * account updates the row instead of adding a second one.
 * A key that could not be checked is stored as `untested` rather than refused — the network
 * may be the problem, not the key.
 */
export async function POST(request: Request) {
	try {
		const result = await getUseCases().credentials.importApiKey("xiaomi-mimo", await request.json())
		if (!result.ok) {
			return NextResponse.json({ error: result.error }, { status: result.status })
		}
		return NextResponse.json({
			success: true,
			validated: result.validated,
			modelCount: result.modelCount,
			updated: result.updated,
			connection: result.connection,
		})
	} catch (error) {
		return failed(error, "MiMoCode key import failed", "oauth/xiaomi-mimo/api-key")
	}
}
