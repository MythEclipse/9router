import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

async function client(request: Request) {
	return createApiClient({
		session: sessionClaimsOf(await getSessionContext()),
		useCases: getUseCases(),
		// The probe decides local-vs-remote from these headers, so the request's own must cross
		// the boundary. They are read here, never taken from the body.
		headers: request.headers,
	})
}

/**
 * Lists the tools a Cowork MCP server exposes.
 *
 * A server answering 401 or 403 is reported as `requiresAuth` rather than as a failure: that is
 * a correct answer from an OAuth server, and the screen should stop asking instead of showing
 * an error.
 */
export async function POST(request: Request) {
	let body: unknown
	try {
		body = await request.json()
	} catch {
		return NextResponse.json({ error: "Invalid request body", tools: [] }, { status: 400 })
	}
	const answer = await (await client(request)).coworkMcp.probeTools({ body })
	return NextResponse.json(answer.body, { status: answer.status })
}
