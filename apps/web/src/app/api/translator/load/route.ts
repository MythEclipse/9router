/**
 * GET /api/translator/load - one captured pipeline dump.
 *
 * The name is caller-supplied and used to form a path, so the closed rule in
 * `domain/translator.ts` runs before the filesystem is touched. 400 for a refused name and 404 for
 * a missing file are kept apart on purpose: a traversal attempt must not look like a typo.
 */
import { getDashboardAuthSession } from "@9router/auth/dashboardSession"
import { sessionFromClaims } from "9router-api/infrastructure/session-from-cookie"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { createApiClient } from "@/lib/orpcClient"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
	const cookieStore = await cookies()
	const payload = await getDashboardAuthSession(cookieStore.get("auth_token")?.value)
	const session = sessionFromClaims((payload ?? {}) as Record<string, unknown>)

	const { searchParams } = new URL(request.url)
	const answer = await createApiClient({
		session,
		useCases: getUseCases(),
		headers: request.headers,
	}).translator.load({ file: searchParams.get("file") })

	return NextResponse.json(answer.body, { status: answer.status })
}
