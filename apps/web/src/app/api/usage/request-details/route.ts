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

import { canReadFullRequestPayload } from "9router-api/domain/observability"

/**
 * GET /api/usage/request-details - one page of stored requests.
 *
 * The paging rules, the scope filter and the payload-redaction decision live in the use-case
 * and the domain; this route only carries the query string. Redaction fails closed: an
 * unreadable settings row never reveals a conversation.
 */
export async function GET(request: Request) {
	try {
		const { searchParams } = new URL(request.url)
		const query = {
			page: searchParams.get("page"),
			pageSize: searchParams.get("pageSize"),
			provider: searchParams.get("provider"),
			model: searchParams.get("model"),
			connectionId: searchParams.get("connectionId"),
			status: searchParams.get("status"),
			startDate: searchParams.get("startDate"),
			endDate: searchParams.get("endDate"),
		}
		return NextResponse.json(await (await client()).usage.requestDetails(query))
	} catch (error) {
		return failed(error, "Failed to fetch request details", "usage/request-details")
	}
}

/**
 * The role gate that guards full payloads, exported for the `[id]` route to reuse.
 *
 * It is the same function the listing's redaction consults, so the two cannot disagree about
 * who may read a conversation.
 */
export { canReadFullRequestPayload }
