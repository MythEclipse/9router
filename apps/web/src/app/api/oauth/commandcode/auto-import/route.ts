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
 * GET /api/oauth/commandcode/auto-import
 *
 * Reads the key `commandcode login` already wrote on this machine. A miss is
 * `found: false` with the action to take — "Command Code token not found in Command Code's
 * auth.json. Please log in to Command Code first." — not an error status: never having run
 * the CLI is a normal state on a fresh install.
 * Where the search looks, and in what order, lives in `oauthImportHost`.
 */
export async function GET(request: Request) {
	try {
		return NextResponse.json(
			await (await client(request)).oauth.autoImport({ provider: "commandcode" }),
		)
	} catch (error) {
		return failed(error, "commandcode auto-import failed", "oauth/commandcode/auto-import")
	}
}
