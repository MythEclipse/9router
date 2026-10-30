/**
 * POST /api/usage/[connectionId]/claude-reset - spend one free Claude limit-reset grant.
 *
 * The grant is irreversible, so the rules about who may spend one and how upstream's answer maps
 * to a status live in `domain/claude-reset.ts`, and the sequence around the refresh lives in
 * `application/claude-reset/reset-grant.ts`. This route shapes the reply.
 */
import { getDashboardAuthSession } from "@9router/auth/dashboardSession"
import { sessionFromClaims } from "9router-api/infrastructure/session-from-cookie"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { createApiClient } from "@/lib/orpcClient"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

export async function POST(
	request: Request,
	{ params }: { params: Promise<{ connectionId: string }> },
) {
	const cookieStore = await cookies()
	const payload = await getDashboardAuthSession(cookieStore.get("auth_token")?.value)
	const session = sessionFromClaims((payload ?? {}) as Record<string, unknown>)

	const { connectionId } = await params
	const body = (await request.json().catch(() => ({}))) as { grantId?: unknown }

	const answer = await createApiClient({
		session,
		useCases: getUseCases(),
		headers: request.headers,
	}).claudeReset.spend({ connectionId, grantId: body.grantId })

	return NextResponse.json(answer.body, { status: answer.status })
}
