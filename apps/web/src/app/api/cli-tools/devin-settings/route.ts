import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * Devin CLI detection.
 *
 * Detection only: Devin keeps its own credentials and the operator runs `devin auth login`, so
 * there is nothing here to write, reset or configure.
 */
export async function GET(request: Request) {
	const client = createApiClient({
		session: sessionClaimsOf(await getSessionContext()),
		useCases: getUseCases(),
		headers: request.headers,
	})
	const answer = await client.cliTools.readDevin()
	return NextResponse.json(answer.body, { status: answer.status })
}
