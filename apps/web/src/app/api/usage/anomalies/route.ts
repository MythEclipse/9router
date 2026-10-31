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
 * GET /api/usage/anomalies - hours whose spend is far above their own trailing baseline.
 *
 * Read-only, so it is safe to poll. The detector needs history before it can accuse an hour of
 * anything, which is why the use-case widens any window shorter than a day.
 */
export async function GET(request: Request) {
	try {
		const { searchParams } = new URL(request.url)
		return NextResponse.json(
			await (await client()).usage.anomalies.detect({
				period: searchParams.get("period") || undefined,
			}),
		)
	} catch (error) {
		return failed(error, "Failed to detect spend anomalies", "usage/anomalies")
	}
}

/**
 * POST /api/usage/anomalies - detect, then file a notice per finding.
 *
 * Separate from the GET because it writes: the notices land in the notification feed, and the
 * alert dispatch carries them to the configured channel. A scheduler (or the "check now" button)
 * calls this; a page load calls the GET.
 */
export async function POST(request: Request) {
	try {
		const { searchParams } = new URL(request.url)
		return NextResponse.json(
			await (await client()).usage.anomalies.raise({
				period: searchParams.get("period") || undefined,
			}),
		)
	} catch (error) {
		return failed(error, "Failed to raise spend anomalies", "usage/anomalies")
	}
}
