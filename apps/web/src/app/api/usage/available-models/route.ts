import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

async function client() {
	return createApiClient({
		session: sessionClaimsOf(await getSessionContext()),
		useCases: getUseCases(),
		headers: new Headers(),
	})
}

/**
 * GET /api/usage/available-models - read-only catalogue for the signing-in key.
 *
 * A key session holding only `viewUsage` cannot open /api/models or /api/combos, so the
 * catalogue is rebuilt server side and narrowed to the session's allowedModels. The assembly
 * moved to `lib/usage/availableModelsHost.ts` so the oRPC procedure and this route cannot
 * diverge on which rows are call paths and which are display duplicates.
 */
export async function GET() {
	try {
		const response = NextResponse.json(await (await client()).usage.availableModels())
		response.headers.set("Cache-Control", "no-store")
		return response
	} catch (error) {
		return failed(error, "Failed to fetch available models", "usage/available-models")
	}
}
