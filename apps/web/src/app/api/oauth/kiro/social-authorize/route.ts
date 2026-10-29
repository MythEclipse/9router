import { NextResponse } from "next/server"
import { KiroService } from "@/lib/oauth/services/kiro"
import { generatePKCE } from "@/lib/oauth/utils/pkce"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * GET /api/oauth/kiro/social-authorize
 * Generate Google/GitHub social login URL for manual callback flow
 * Uses kiro:// custom protocol as required by AWS Cognito
 */
export async function GET(request: Request) {
	try {
		const service = new KiroService()
		const answer = getUseCases().oauth.authorizeKiroSocial(
			new URL(request.url).searchParams.get("provider"),
			{
				generatePkce: generatePKCE,
				buildLoginUrl: (provider, codeChallenge, state) =>
					service.buildSocialLoginUrl(provider, codeChallenge, state),
			},
		)
		return NextResponse.json(answer.body, { status: answer.status })
	} catch (error) {
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : "Unknown error" },
			{ status: 500 },
		)
	}
}
