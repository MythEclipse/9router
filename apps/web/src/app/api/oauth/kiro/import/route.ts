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
 * POST /api/oauth/kiro/import
 *
 * Takes a refresh token from the Kiro IDE. An IDC (organisation) token also carries
 * clientId/clientSecret/region, because it refreshes at the regional OIDC endpoint.
 * A token is proved against the provider before it is saved, so a bad one never becomes a
 * row the dashboard has to explain later.
 *
 * The refusal's status is the provider's, so the procedure raises it rather than answering
 * 200 with an error body — the panel tells "the token was rejected" from "the import
 * worked" by the status, not by parsing the body.
 */
export async function POST(request: Request) {
	try {
		const body = await request.json()
		const answer = await (await client(request)).oauth.importToken({ provider: "kiro", body })
		return NextResponse.json({ success: true, connection: answer.connection })
	} catch (error) {
		return failed(error, "kiro import failed", "oauth/kiro/import")
	}
}
