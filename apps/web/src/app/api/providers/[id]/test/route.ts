/**
 * Probe one connection. A missing connection is a 404 rather than a failed probe;
 * `check-connection.ts` draws that line.
 *
 * Delegates: what a probe does, and what its outcome proves about the connection, are
 * rules and live in `9router-api`.
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
			headers: _request.headers,
		})
		return NextResponse.json(await client.providers.test({ id }))
	} catch (error) {
		return failed(error, "Test failed", "Error testing connection")
	}
}
