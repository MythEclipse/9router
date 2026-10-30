import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * POST /api/oauth/kiro/import-cli-proxy
 * Import Kiro CLIProxyAPI auth JSON for Microsoft external_idp accounts.
 *
 * The envelope guess, the refusal message and the normaliser are all in `apps/api` now; this
 * route only carries the body across and returns the refusal's own status.
 */
export async function POST(request: Request) {
	let body: unknown
	try {
		body = await request.json()
	} catch {
		return NextResponse.json({ error: "Invalid or empty request body" }, { status: 400 })
	}
	const client = createApiClient({
		session: sessionClaimsOf(await getSessionContext()),
		useCases: getUseCases(),
		headers: request.headers,
	})
	// A refusal never reaches here: `orRefuse` turns it into an `AppError` carrying the provider's
	// own status, so `toORPCError` answers 4xx and the panel keeps the reason verbatim.
	const answer = await client.oauth.importKiroCliAuth({ body })
	return NextResponse.json(answer)
}
