import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * GET /api/requests/explain?id=<request id> - why this request looked the way it did.
 *
 * Answers the pipeline, the field-level diff between the client body and the provider body, and
 * the cost. It also answers with an `unknown` list: which connections the router considered and
 * why it skipped them is not in the row, and a report that stayed silent about that would read
 * as a complete account of the decision.
 */
export async function GET(request: Request) {
	try {
		const id = new URL(request.url).searchParams.get("id")
		if (!id) {
			return NextResponse.json({ error: "id is required" }, { status: 400 })
		}

		const client = createApiClient({
			session: sessionClaimsOf(await getSessionContext()),
			useCases: getUseCases(),
			headers: new Headers(),
		})
		const explanation = await (await client).requests.explain({ id })

		return NextResponse.json(explanation, { headers: { "cache-control": "no-store" } })
	} catch (error) {
		return failed(error, "Failed to explain the request", "requests/explain")
	}
}
