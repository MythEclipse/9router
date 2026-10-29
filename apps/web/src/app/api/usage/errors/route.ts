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
 * GET /api/usage/errors - error counts folded by class.
 *
 * The classification and the scope filter both live in the use-case, so this route and the
 * oRPC procedure answer identically; `?period=` is refused by the shared period rule rather
 * than silently clamped here.
 */
export async function GET(request: Request) {
	try {
		const { searchParams } = new URL(request.url)
		return NextResponse.json(
			await (await client()).usage.errors({
				period: searchParams.get("period") || undefined,
			}),
		)
	} catch (error) {
		return failed(error, "Failed to fetch usage errors", "usage/errors")
	}
}
