import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

async function client(request: Request) {
	return createApiClient({
		session: sessionClaimsOf(await getSessionContext()),
		useCases: getUseCases(),
		headers: request.headers,
	})
}

/**
 * POST /api/oauth/iflow/cookie — { cookie }
 *
 * iFlow Cookie-Based Authentication. The fetch choice follows the GitLab PAT rule; this
 * path used to call bare `fetch`, so the SSRF guard never ran on it.
 */
export async function POST(request: Request) {
	try {
		const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
		if (!body || typeof body.cookie !== "string" || !body.cookie) {
			return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
		}
		const answer = await (await client(request)).oauth.iflowCookie({ cookie: body.cookie })
		return NextResponse.json(answer.body, { status: answer.status })
	} catch (error) {
		return failed(error, "iFlow cookie import failed", "oauth/iflow/cookie")
	}
}
