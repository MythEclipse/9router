/**
 * Probe every active connection in a group.
 *
 * Delegates: which connections a group covers lives in `domain/batch-selection.ts`; the
 * row shape and its counts in `domain/batch-result.ts`. The body is forwarded as sent so
 * that an unknown `mode` fails in the use-case, where the message can name the modes that
 * do work.
 */
import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
	try {
		const body = await request.json()
		const client = createApiClient({
			session: sessionClaimsOf(await getSessionContext()),
			useCases: getUseCases(),
		})
		return NextResponse.json(
			await client.providers.testBatch({ mode: body?.mode, providerId: body?.providerId }),
		)
	} catch (error) {
		return failed(error, "Batch test failed", "Error in batch test")
	}
}
