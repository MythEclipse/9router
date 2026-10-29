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
 * GET /api/oauth/kiro/auto-import
 *
 * Reads the credential the provider's own tool already wrote on this machine. A miss is
 * `found: false` with the action to take — "Kiro token not found in the AWS SSO cache. Please log in to Kiro first." — not an error
 * status; nobody has logged in yet is a normal state.
 * Where the search looks, and in what order, lives in `oauthImportHost`.
 */
export async function GET(request: Request) {
	try {
		return NextResponse.json(await (await client(request)).oauth.autoImport({ provider: "kiro" }))
	} catch (error) {
		return failed(error, "kiro auto-import failed", "oauth/kiro/auto-import")
	}
}
