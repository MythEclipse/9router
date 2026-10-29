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
 * GET /api/usage/leaderboard - per-model request/token/cost totals, best first.
 *
 * `?period=` used to be unvalidated here while the error panel refused the same value; the two
 * now share one rule, so a typo is a 400 in both places instead of a week of data labelled
 * with what the caller asked for.
 */
export async function GET(request: Request) {
	try {
		const { searchParams } = new URL(request.url)
		return NextResponse.json(
			await (await client()).usage.leaderboard({
				period: searchParams.get("period") || undefined,
			}),
		)
	} catch (error) {
		return failed(error, "Failed to fetch leaderboard", "usage/leaderboard")
	}
}
