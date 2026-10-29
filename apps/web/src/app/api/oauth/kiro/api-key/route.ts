import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * POST /api/oauth/kiro/api-key
 *
 * Imports a Kiro bearer key. There is no refresh token, so the stored expiry is a long
 * horizon and the proactive refresh path is never spent.
 * A key that could not be checked is stored as `untested` rather than refused — the network
 * may be the problem, not the key.
 */
export async function POST(request: Request) {
	try {
		const result = await getUseCases().credentials.importApiKey("kiro", await request.json())
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
		return failed(error, "Kiro key import failed", "oauth/kiro/api-key")
	}
}
