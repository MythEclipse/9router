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

import { refreshAndUpdateCredentials } from "@/lib/usage/connectionRefresh"

/**
 * GET /api/usage/[connectionId] - quota for one connection, from the provider.
 *
 * The five steps this route used to perform inline — read, gate eligibility, refresh only when
 * OAuth, retry only when a refresh token exists, read an "expired" answer that arrived as a
 * 200 — are ordered in `application/usage/read-connection-usage.ts`, where a second caller
 * cannot reorder them. Ordering is the whole safety property: OpenAI rotates the refresh token
 * on every refresh, so refreshing from a stale snapshot revokes the session.
 *
 * A "usage not available for this provider" answer stays a 200 with a message: the panel
 * renders it as an explanation, not as an error state.
 */
export async function GET(
	request: Request,
	{ params }: { params: Promise<{ connectionId: string }> },
) {
	try {
		const { connectionId } = await params
		const force = new URL(request.url).searchParams.get("force") === "1"
		const answer = await (await client()).usage.connection({ connectionId, force })
		if (answer.kind === "refusal") {
			return NextResponse.json({ message: answer.refusal.message }, { status: answer.refusal.status })
		}
		return NextResponse.json(answer.usage)
	} catch (error) {
		return failed(error, "Failed to read connection usage", "usage/connection")
	}
}

// Still exported for `codex-reset-credits`, which drives the same refresh path. Imported above
// for this module's own use; the canonical implementation is `lib/usage/connectionRefresh.ts`.
export { refreshAndUpdateCredentials }
