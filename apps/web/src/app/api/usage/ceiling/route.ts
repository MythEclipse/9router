import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * POST /api/usage/ceiling - would this request fit under the key's spending ceiling?
 *
 * Body: `{ keyId, provider, model, promptTokens?, completionTokens?, cachedTokens? }`.
 *
 * Advisory by design: the gateway cannot price a request before it has the tokens, so a client
 * asks first and can shrink the request instead of being cut off mid-stream. A `deny` here is a
 * prediction, and `unknown` means the model has no rate — never read that as `allow`.
 */
export async function POST(request: Request) {
	try {
		const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
		const client = createApiClient({
			session: sessionClaimsOf(await getSessionContext()),
			useCases: getUseCases(),
			headers: new Headers(),
		})
		const answer = await (await client).usage.ceiling(body as never)
		return NextResponse.json(answer, { headers: { "cache-control": "no-store" } })
	} catch (error) {
		return failed(error, "Failed to check the spending ceiling", "usage/ceiling")
	}
}
