/**
 * POST /api/translator/save - write one captured dump.
 *
 * The filename is caller-supplied and lands in `path.join`, so `translatorDumpFile` is the only
 * thing standing between the dashboard and an arbitrary file write. It runs in the use-case before
 * the store is asked to write anything, and it must stay an exact match.
 */
import { getDashboardAuthSession } from "@9router/auth/dashboardSession"
import { sessionFromClaims } from "9router-api/infrastructure/session-from-cookie"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { createApiClient } from "@/lib/orpcClient"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
	const cookieStore = await cookies()
	const payload = await getDashboardAuthSession(cookieStore.get("auth_token")?.value)
	const session = sessionFromClaims((payload ?? {}) as Record<string, unknown>)

	const body: unknown = await request.json().catch(() => ({}))
	const answer = await createApiClient({
		session,
		useCases: getUseCases(),
		headers: request.headers,
	}).translator.save({ body })

	return NextResponse.json(answer.body, { status: answer.status })
}
