/**
 * Probe every model this connection can reach.
 *
 * Delegates: the warm-up-then-fan-out rule, and the serial case for cookie providers,
 * live in `domain/model-probe.ts`.
 */
import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
	try {
		const { id } = await params
		const client = createApiClient({
			session: sessionClaimsOf(await getSessionContext()),
			useCases: getUseCases(),
		})
		return NextResponse.json(await client.providers.testModels({ id }))
	} catch (error) {
		return failed(error, "Test failed", "Error testing models")
	}
}
