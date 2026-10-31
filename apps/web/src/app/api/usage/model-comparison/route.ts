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
 * GET /api/usage/model-comparison - cost per request and per million tokens, per model.
 *
 * The leaderboard answers "what did this model cost"; this answers "what does it cost to run",
 * which is the question a routing decision is made on. A model used twice for a fortune and
 * one used a thousand times for the same total rank very differently in the two views.
 */
export async function GET(request: Request) {
	try {
		const { searchParams } = new URL(request.url)
		return NextResponse.json(
			await (await client()).usage.modelComparison({
				period: searchParams.get("period") || undefined,
			}),
		)
	} catch (error) {
		return failed(error, "Failed to compare model costs", "usage/model-comparison")
	}
}
