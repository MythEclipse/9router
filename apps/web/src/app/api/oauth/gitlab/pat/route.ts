import { NextResponse } from "next/server"
import { isLocalRequest } from "@/dashboardGuard"
import { getUseCases } from "@/lib/useCases"
import { createProviderConnection } from "@/models"
import { fetchPublic } from "@/shared/utils/ssrfGuard"

export const dynamic = "force-dynamic"

/**
 * POST /api/oauth/gitlab/pat
 * Authenticate GitLab Duo with a Personal Access Token (PAT)
 */
export async function POST(request: Request) {
	let body: unknown
	try {
		body = await request.json()
	} catch {
		return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
	}

	// The base URL is client-supplied, so a remote caller must not be able to point the
	// server at an internal/loopback/metadata host. Local callers keep self-hosted GitLab
	// on a private network reachable (mirrors provider-nodes/validate + auth/oidc).
	const answer = await getUseCases().oauth.importGitlabPat(body, {
		fetchImpl: isLocalRequest(request) ? globalThis.fetch : fetchPublic,
		createConnection: createProviderConnection,
	})

	return NextResponse.json(answer.body, { status: answer.status })
}
