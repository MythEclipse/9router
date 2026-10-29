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
 * GET /api/usage/request-details/[id] - one stored request, in full.
 *
 * The listing redacts every conversation payload; this exists for the administrator asking
 * what a request actually sent. `canReadFullRequestPayload` is the same rule the listing's
 * redaction consults, so the two cannot disagree about who may read a conversation.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
	try {
		const { id } = await params
		const session = sessionClaimsOf(await getSessionContext())
		if (!canReadFullRequestPayload(session?.role ?? null)) {
			return NextResponse.json(
				{ error: "Only a password sign-in can read a full request payload" },
				{ status: 403 },
			)
		}
		return NextResponse.json(await (await client()).usage.requestDetail({ id }))
	} catch (error) {
		return failed(error, "Failed to fetch request detail", "usage/request-details/id")
	}
}
