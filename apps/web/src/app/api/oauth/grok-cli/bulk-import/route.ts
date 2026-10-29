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
 * POST /api/oauth/grok-cli/bulk-import
 *
 * Imports the accounts an export file holds: a bare array, a single object, or
 * `{ accounts: [...] }`. Each row is written or refused on its own — one bad entry does not
 * throw away the ones that were fine, and the response says which index failed and why.
 *
 * A partial success is a 200: the counts and per-index results are the answer, and turning
 * "three of five imported" into an error status would hide the three.
 */
export async function POST(request: Request) {
	try {
		const body = await request.json()
		return NextResponse.json(
			await (await client(request)).oauth.importBatch({ provider: "grok-cli", body }),
		)
	} catch (error) {
		return failed(error, "Grok CLI bulk import failed", "oauth/grok-cli/bulk-import")
	}
}
