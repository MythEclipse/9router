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
 * GET /api/usage/latency - p50/p95/p99 per provider and model, plus the duration histogram.
 *
 * The numbers come from the requests this gateway timed itself, so they describe the path a
 * caller actually takes (queue, translation, upstream) rather than an upstream's own report of
 * itself.
 *
 * `?period=` is validated by the shared reporting rule: an unknown window is refused with 400
 * instead of quietly answering a different one.
 */
export async function GET(request: Request) {
	try {
		const { searchParams } = new URL(request.url)
		return NextResponse.json(
			await (await client()).usage.latency({
				period: searchParams.get("period") || undefined,
			}),
		)
	} catch (error) {
		return failed(error, "Failed to read latency", "usage/latency")
	}
}
