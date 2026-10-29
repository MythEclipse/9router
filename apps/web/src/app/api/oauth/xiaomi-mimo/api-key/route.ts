import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

async function client(request: Request) {
	return createApiClient({
		session: sessionClaimsOf(await getSessionContext()),
		useCases: getUseCases(),
		headers: request.headers,
	})
}

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
		const body = await request.json()
		const answer = await (await client(request)).oauth.importApiKey({ provider: "xiaomi-mimo", body })
		// The answer names what the check found; every field is passed through because the
		// screen renders a different sentence for each combination.
		return NextResponse.json({
			success: true,
			validated: answer.validated,
			modelCount: answer.modelCount,
			updated: answer.updated,
			connection: answer.connection,
		})
	} catch (error) {
		return failed(error, "MiMoCode key import failed", "oauth/xiaomi-mimo/api-key")
	}
}
