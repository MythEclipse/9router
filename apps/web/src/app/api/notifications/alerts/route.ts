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
 * POST /api/notifications/alerts?action=test - push pending alerts to the configured channels.
 *
 * The dashboard cannot do this on page load: an install with no channels configured must not
 * pay for a network call on every render, and a dispatch that runs while the operator is
 * watching is the one case where a slow destination blocks a page. So it is a call something
 * else makes — a cron, a CI hook, or the "Send test" button (`?action=test`).
 */
export async function POST(request: Request) {
	try {
		const action = new URL(request.url).searchParams.get("action")
		const useCase = (await client()).notifications.alerts
		return NextResponse.json(action === "test" ? await useCase.test() : await useCase.dispatch())
	} catch (error) {
		return failed(error, "Failed to dispatch alerts", "notifications/alerts")
	}
}
