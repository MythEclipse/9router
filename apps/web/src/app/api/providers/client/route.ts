/**
 * The connection listing the usage panel reads.
 *
 * Delegates: the disclosure whitelist, usage eligibility and paging live in
 * `domain/client-listing.ts`.
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
			headers: request.headers,
		})
		return NextResponse.json(
			await client.providers.clientList({
				provider: searchParams.get("provider"),
				accountStatus: searchParams.get("accountStatus"),
				sort: searchParams.get("sort"),
				page: searchParams.get("page"),
				pageSize: searchParams.get("pageSize"),
			}),
		)
	} catch (error) {
		return failed(error, "Failed to fetch providers", "Error fetching providers for client")
	}
}
