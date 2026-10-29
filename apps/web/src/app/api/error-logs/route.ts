/**
 * Stored diagnostics.
 *
 * Delegates: the page-size rule and the "did the delete actually happen" check are
 * rules, so they live in `9router-api`. The `success` envelope stays because the
 * dashboard reads that field — the procedure returns the page, not the envelope.
 *
 * The session is translated here only because the router's `authed` gate needs one;
 * these two procedures take no caller argument, which is why `error-logs` moved in a
 * single step rather than the two that `theme` and `keys` needed.
 */
import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { getUseCases } from "@/lib/useCases"
import { toResponse } from "../response"

export const dynamic = "force-dynamic"

async function client() {
	return createApiClient({
		session: sessionClaimsOf(await getSessionContext()),
		useCases: getUseCases(),
	})
}

export async function GET(request: Request) {
	try {
		const limit = new URL(request.url).searchParams.get("limit") ?? undefined
		const page = await (await client()).errorLogs.list({ limit })
		return NextResponse.json({ success: true, ...page })
	} catch (error) {
		return toResponse(error)
	}
}

export async function DELETE() {
	try {
		return NextResponse.json({ success: true, ...(await (await client()).errorLogs.clear()) })
	} catch (error) {
		return toResponse(error)
	}
}
