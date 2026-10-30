import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * GET — list every Hermes profile on this machine (the default home plus `~/.hermes/profiles/*`).
 *
 * Discovery is filesystem-based: a directory only counts as a profile when it carries one of
 * Hermes' identity files, mirroring what `hermes profile list` accepts.
 */
export async function GET(request: Request) {
	const client = createApiClient({
		session: sessionClaimsOf(await getSessionContext()),
		useCases: getUseCases(),
		headers: request.headers,
	})
	const answer = await client.hermes.listProfiles()
	return NextResponse.json(answer, { status: 200 })
}
