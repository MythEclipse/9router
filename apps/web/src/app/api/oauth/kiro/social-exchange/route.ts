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
 * POST /api/oauth/kiro/social-exchange
 *
 * Exchange the authorization code for tokens. The callback arrives as
 * `kiro://kiro.kiroAgent/authenticate-success?code=XXX&state=YYY`, so `code` is a callback
 * URL rather than a bare code for this provider.
 */
export async function POST(request: Request) {
	try {
		const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
		if (!body) {
			return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
		}
		const answer = await (await client(request)).oauth.kiroSocial.exchange(body)
		return NextResponse.json(answer.body, { status: answer.status })
	} catch (error) {
		return failed(error, "Kiro social exchange failed", "oauth/kiro/social-exchange")
	}
}
