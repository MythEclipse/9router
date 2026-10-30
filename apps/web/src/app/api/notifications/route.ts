/**
 * GET /api/notifications - the bell feed.
 * POST /api/notifications - { action: "read", id }, or { action: "clear", id } for one dismissed
 * row / { action: "clear", kind, dedupeKey } for a resolved condition.
 *
 * Closed to key sessions: these messages name quota pressure and failed attempts against this
 * install, which is administrator information. The shape rules live in
 * `domain/notification-feed.ts`; the use-case applies them and every mutating answer carries the
 * new unread count, so the badge and the list cannot disagree.
 *
 * The session is read from the cookie rather than through `getSessionContext()` because
 * `canReadNotifications` branches on `role` — a key session must arrive as `apikey`, not as the
 * `"admin"` a normalised context would assume.
 */
import { getDashboardAuthSession } from "@9router/auth/dashboardSession"
import { sessionFromClaims } from "9router-api/infrastructure/session-from-cookie"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { createApiClient } from "@/lib/orpcClient"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

async function client(request: Request) {
	const cookieStore = await cookies()
	const payload = await getDashboardAuthSession(cookieStore.get("auth_token")?.value)
	const session = sessionFromClaims((payload ?? {}) as Record<string, unknown>)
	return createApiClient({ session, useCases: getUseCases(), headers: request.headers })
}

export async function GET(request: Request) {
	const { searchParams } = new URL(request.url)
	const answer = await (await client(request)).notifications.list({
		limit: searchParams.get("limit"),
	})
	return NextResponse.json(answer.body, { status: answer.status, headers: answer.headers })
}

export async function POST(request: Request) {
	const body: unknown = await request.json().catch(() => ({}))
	const answer = await (await client(request)).notifications.update({ body })
	return NextResponse.json(answer.body, { status: answer.status })
}
