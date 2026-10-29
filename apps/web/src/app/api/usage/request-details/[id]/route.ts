import { getDashboardAuthSession } from "@9router/auth/dashboardSession"
import { canReadFullRequestPayload } from "9router-api/domain/observability"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { getRequestDetailById } from "@/lib/requestDetailsDb"

export const dynamic = "force-dynamic"

/**
 * GET /api/usage/request-details/[id]
 *
 * The listing route (/api/usage/request-details) redacts every conversation
 * payload: the stored detail carries the full client request body and the
 * provider response, so handing that to any dashboard-authenticated session
 * would read other users' conversations. That redaction is right for a list.
 *
 * This route serves one record, in full, to a password session only - the
 * administrator asking "what did this request actually send". A key session is
 * refused outright rather than shown a redacted body, because a redacted body
 * would be indistinguishable from an empty one and only invite pointless retries.
 * The role check is `canReadFullRequestPayload` in `domain/observability.ts`, which
 * also owns the listing's redaction, so the two cannot disagree about who may read
 * a conversation.
 */
export async function GET(_request, context) {
	try {
		const id = (await context?.params)?.id
		if (!id) {
			return NextResponse.json({ error: "Missing request id" }, { status: 400 })
		}

		const cookieStore = await cookies()
		const session = await getDashboardAuthSession(cookieStore.get("auth_token")?.value)
		if (!canReadFullRequestPayload(typeof session?.role === "string" ? session.role : null)) {
			return NextResponse.json(
				{ error: "Only a password sign-in can read a full request payload" },
				{ status: 403 },
			)
		}

		const detail = await getRequestDetailById(id)
		if (!detail) {
			return NextResponse.json({ error: "Request not found" }, { status: 404 })
		}

		return NextResponse.json({ detail })
	} catch (error) {
		console.log("Error reading request detail:", error)
		return NextResponse.json({ error: "Failed to read request detail" }, { status: 500 })
	}
}
