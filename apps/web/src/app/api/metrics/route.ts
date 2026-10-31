import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { bearerSession } from "@/lib/apiKeyBearer"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * GET /metrics - the Prometheus scrape.
 *
 * Two ways in, because the caller decides which one it can do: a dashboard session (the
 * browser following a link) or an API key bearer (Prometheus, which cannot carry a cookie).
 * Both resolve to the same session shape, so the scope rules and the numbers behind them are
 * the ones the usage page already applies — a key sees its own traffic, never the install's.
 *
 * `no-store` is not decoration: a cached scrape would report the same numbers until the cache
 * expired, and every alert built on it would be blind for that long.
 */
export async function GET(request: Request) {
	try {
		const session = sessionClaimsOf(await getSessionContext()) ?? (await bearerSession(request))
		if (!session) {
			return new NextResponse("Unauthorized\n", {
				status: 401,
				headers: {
					"content-type": "text/plain; charset=utf-8",
					"www-authenticate": 'Bearer realm="9router metrics"',
				},
			})
		}

		const { searchParams } = new URL(request.url)
		const scrape = await createApiClient({
			session,
			useCases: getUseCases(),
			headers: request.headers,
		}).usage.metrics({ period: searchParams.get("period") || undefined })

		return new NextResponse(scrape.body, {
			status: 200,
			headers: { "content-type": scrape.contentType, "cache-control": "no-store" },
		})
	} catch (error) {
		return failed(error, "Failed to build the metrics scrape", "metrics")
	}
}
