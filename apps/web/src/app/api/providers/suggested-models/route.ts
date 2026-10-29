/**
 * The model picker's suggestions for one provider.
 *
 * Delegates: the filter table and the stored-copy-before-built-in preference live in
 * `domain/model-catalogue.ts`; the whole-request ceiling in `suggest-models.ts`.
 */
import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
	try {
		const { searchParams } = new URL(request.url)
		const client = createApiClient({
			session: sessionClaimsOf(await getSessionContext()),
			useCases: getUseCases(),
		})
		const answer = await client.providers.suggestModels({
			url: searchParams.get("url"),
			type: searchParams.get("type"),
		})
		return NextResponse.json({
			data: answer.data,
			...(answer.stale ? { stale: true } : {}),
			...(answer.message ? { error: answer.message } : {}),
			...(answer.syncedAt ? { syncedAt: answer.syncedAt } : {}),
		})
	} catch (error) {
		return failed(error, "Suggested models failed", "Error fetching suggested models")
	}
}
