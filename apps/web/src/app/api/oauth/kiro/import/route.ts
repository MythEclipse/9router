import { NextResponse } from "next/server"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * POST /api/oauth/kiro/import
 *
 * Takes a refresh token from the Kiro IDE. An IDC (organisation) token also carries
 * clientId/clientSecret/region, because it refreshes at the regional OIDC endpoint.
 * A token is proved against the provider before it is saved, so a bad one never becomes a
 * row the dashboard has to explain later.
 */
export async function POST(request: Request) {
	try {
		const result = await getUseCases().credentials.importToken("kiro", await request.json())
		if (!result.ok) {
			return NextResponse.json({ error: result.error }, { status: result.status })
		}
		return NextResponse.json({ success: true, connection: result.connection })
	} catch (error) {
		return failed(error, "Kiro import failed", "oauth/kiro/import")
	}
}
