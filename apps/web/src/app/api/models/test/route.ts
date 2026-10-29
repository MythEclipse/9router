/**
 * Ping one model through the internal completions or embeddings path, so the dashboard
 * can show a real result rather than a guess.
 *
 * Delegates: how a probe is made, and what its outcome means, are rules and live in
 * `9router-api`. The guard denies this path by default, so the session travels with the
 * call.
 */
import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/** Body: `{ model, kind? }`. */
export async function POST(request: Request) {
	try {
		const body = await request.json().catch(() => undefined)
		const client = createApiClient({
			session: sessionClaimsOf(await getSessionContext()),
			useCases: getUseCases(),
		})
		return NextResponse.json(await client.models.probe(body))
	} catch (error) {
		return failed(error, "Model test failed", "Model test failed")
	}
}
