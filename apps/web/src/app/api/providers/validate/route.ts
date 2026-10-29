/**
 * Ask the provider whether a pasted key works, before storing it.
 *
 * Delegates: what each provider's HTTP status proves about the key lives in
 * `domain/credential-verdict.ts`; the per-provider probe requests in
 * `application/providers/validate-credential.ts`. The body is forwarded as sent — the
 * verdict depends on fields this route has no business knowing.
 */
import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
	try {
		const body = await request.json()
		const client = createApiClient({
			session: sessionClaimsOf(await getSessionContext()),
			useCases: getUseCases(),
			headers: request.headers,
		})
		return NextResponse.json(await client.providers.validate(body ?? {}))
	} catch (error) {
		return failed(error, "Validation failed", "Error validating API key")
	}
}
