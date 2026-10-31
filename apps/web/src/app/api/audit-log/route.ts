import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

async function client() {
	return createApiClient({
		session: sessionClaimsOf(await getSessionContext()),
		useCases: getUseCases(),
		headers: new Headers(),
	})
}

/**
 * GET /api/audit-log - the newest mutations, with who and when.
 *
 * `?limit=` is a page size, not a filter: an absent value means the page default and a value
 * above the ceiling is clamped. A value that is not a positive integer is refused by the domain
 * rule (400) rather than silently replaced, because a broken filter that looks like a working
 * one is how a reader concludes nothing happened.
 */
export async function GET(request: Request) {
	try {
		const { searchParams } = new URL(request.url)
		return NextResponse.json(
			await (await client()).audit.list({ limit: searchParams.get("limit") || undefined }),
		)
	} catch (error) {
		return failed(error, "Failed to read the audit log", "audit-log")
	}
}
