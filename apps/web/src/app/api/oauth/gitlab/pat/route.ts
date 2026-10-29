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
 * POST /api/oauth/gitlab/pat — { token, baseUrl? }
 *
 * Authenticate GitLab Duo with a Personal Access Token. The base URL is client-supplied, so
 * the procedure decides which fetch verifies it from the request headers: a remote caller
 * goes through the SSRF guard, a local one keeps a self-hosted GitLab on a private network
 * reachable. That choice moved out of this file so a second route cannot skip it.
 */
export async function POST(request: Request) {
	try {
		const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
		if (!body || typeof body.token !== "string" || !body.token) {
			return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
		}
		const answer = await (await client(request)).oauth.gitlabPat({
			token: body.token,
			...(typeof body.baseUrl === "string" ? { baseUrl: body.baseUrl } : {}),
		})
		return NextResponse.json(answer.body, { status: answer.status })
	} catch (error) {
		return failed(error, "GitLab PAT import failed", "oauth/gitlab/pat")
	}
}
