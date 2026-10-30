/**
 * GET  /api/usage/[connectionId]/codex-reset-credits - what is left to redeem.
 * POST /api/usage/[connectionId]/codex-reset-credits - redeem one.
 *
 * The flow — resolve the row, refresh when the connection is OAuth, call upstream, retry once when
 * the credential turns out to be expired — is in
 * `application/codex-reset-credits/reset-credits.ts`. Every rule it applies (eligibility, when a
 * retry is worth making, how an upstream refusal maps to a status) is in
 * `domain/codex-reset-credits.ts`. The reachable world is `@/lib/codexResetPort`.
 */
import { getDashboardAuthSession } from "@9router/auth/dashboardSession"
import { sessionFromClaims } from "9router-api/infrastructure/session-from-cookie"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { createApiClient } from "@/lib/orpcClient"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

type Params = { params: Promise<{ connectionId: string }> }

async function answer(request: Request, params: Params["params"], call: "read" | "redeem") {
	const cookieStore = await cookies()
	const payload = await getDashboardAuthSession(cookieStore.get("auth_token")?.value)
	const session = sessionFromClaims((payload ?? {}) as Record<string, unknown>)

	const { connectionId } = await params
	const client = createApiClient({
		session,
		useCases: getUseCases(),
		headers: request.headers,
	})
	return client.codexResetCredits[call]({ connectionId })
}

export async function GET(request: Request, { params }: Params) {
	const result = await answer(request, params, "read")
	return NextResponse.json(result.body, { status: result.status })
}

export async function POST(request: Request, { params }: Params) {
	const result = await answer(request, params, "redeem")
	return NextResponse.json(result.body, { status: result.status })
}
