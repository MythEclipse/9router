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
 * GET /api/usage/token-savings - what Token Saver avoided over the period.
 *
 * Unlike the other panels this one does not refuse an unknown period: it reads a rollup table,
 * so a typo costs a wider window rather than a wrong answer presented as a right one.
 */
export async function GET(request: Request) {
	try {
		const { searchParams } = new URL(request.url)
		return NextResponse.json(
			await (await client()).usage.tokenSavings({
				period: searchParams.get("period") || undefined,
			}),
		)
	} catch (error) {
		return failed(error, "Failed to fetch token savings", "usage/token-savings")
	}
}
