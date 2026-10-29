/**
 * A health probe of the engine.
 *
 * Delegates: what the probe checks and what a failure means are rules and live in
 * `9router-api`. The guard denies this path by default, so the session travels with the
 * call.
 */
import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

export async function POST() {
	try {
		const client = createApiClient({
			session: sessionClaimsOf(await getSessionContext()),
			useCases: getUseCases(),
		})
		return NextResponse.json(await client.pxpipe.health())
	} catch (error) {
		// The body carries the card's own shape (`healthy: false`), so the panel can
		// render "unhealthy" rather than an error page. The status stays 500 because
		// that is what the card reads today; changing it would be a client-visible
		// behaviour change smuggled into a migration.
		console.error("[API] pxpipe health check failed:", error)
		return NextResponse.json(
			{ healthy: false, checks: [], error: "pxpipe health check failed" },
			{ status: 500 },
		)
	}
}

// GET mirrors POST so the card can probe on page load without a mutation call.
export const GET = POST
