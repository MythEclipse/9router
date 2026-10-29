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
 * GET /api/oauth/kiro/social-authorize — Google/GitHub social login URL.
 *
 * Uses the `kiro://` custom protocol, as AWS Cognito requires. The verifier and state are
 * answered to the client on purpose: the client pastes back the callback URL, so it has to
 * hold them across a trip the server cannot observe.
 */
export async function GET(request: Request) {
	try {
		const provider = new URL(request.url).searchParams.get("provider")
		const answer = await (await client(request)).oauth.kiroSocial.authorize({ provider })
		return NextResponse.json(answer.body, { status: answer.status })
	} catch (error) {
		return failed(error, "Kiro social authorize failed", "oauth/kiro/social-authorize")
	}
}
