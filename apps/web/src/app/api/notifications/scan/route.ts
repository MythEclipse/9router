/**
 * GET /api/notifications/scan - derive conditions into notifications.
 *
 * The bell button and the header call this. Key names and quota pressure are administrator facts,
 * so a key session gets 401 rather than an empty scan. A failed scan is not an error the caller
 * sees: deriving conditions must never break the dashboard, so the use-case logs it and answers
 * "nothing created" — see `application/notifications/scan-notifications.ts`.
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

	const answer = await createApiClient({
		session,
		useCases: getUseCases(),
		headers: request.headers,
	}).notifications.scan()

	return NextResponse.json(answer.body, { status: answer.status })
}
