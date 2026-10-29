/**
 * Kilo's free tier, cached for an hour and served stale rather than empty when the
 * upstream refuses.
 *
 * Delegates: the cache lifetime, and the decision that a refusal is served stale rather
 * than failed, live in `free-models.ts`. The four outcomes stay distinguishable here
 * because "cached", "stale" and "failed" are three different things to the panel and the
 * use-case is the only place that knows which one happened.
 */
import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

export async function GET() {
	const client = createApiClient({
		session: sessionClaimsOf(await getSessionContext()),
		useCases: getUseCases(),
		headers: new Headers(),
	})
	const result = await client.providers.freeModels()

	switch (result.kind) {
		case "fresh":
			return NextResponse.json({ models: result.models, cached: false })
		case "cached":
			return NextResponse.json({ models: result.models, cached: true })
		case "stale":
			return NextResponse.json({ models: result.models, cached: true, warning: result.warning })
		default:
			return NextResponse.json(
				{ models: [], error: `Failed to fetch Kilo models: ${result.message}` },
				{ status: 502 },
			)
	}
}
