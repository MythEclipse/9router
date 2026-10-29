import { NextResponse } from "next/server"
import { KiroService } from "@/lib/oauth/services/kiro"
import { getUseCases } from "@/lib/useCases"
import { createProviderConnection } from "@/models"

export const dynamic = "force-dynamic"

/**
 * POST /api/oauth/kiro/social-exchange
 * Exchange authorization code for tokens (Google/GitHub social login)
 * Callback URL will be in format: kiro://kiro.kiroAgent/authenticate-success?code=XXX&state=YYY
 */
export async function POST(request: Request) {
	let body: unknown
	try {
		body = await request.json()
	} catch {
		return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
	}

	const service = new KiroService()
	const answer = await getUseCases().oauth.exchangeKiroSocial(body, {
		// The redirect URI is Kiro's own callback; the service already knows it.
		exchangeCode: (code, codeVerifier) => service.exchangeSocialCode(code, codeVerifier),
		emailFromToken: (accessToken) => service.extractEmailFromJWT(accessToken),
		createConnection: createProviderConnection,
		now: Date.now,
	})

	return NextResponse.json(answer.body, { status: answer.status })
}
