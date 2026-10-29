import { clearDashboardAuthCookie } from "@9router/auth/dashboardSession"
import { OIDC_HANDSHAKE_COOKIES, SAML_HANDSHAKE_COOKIE } from "9router-api/domain/dashboard-session"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

/**
 * POST /api/auth/logout - clear the session and any half-finished handshake.
 *
 * The handshake cookies are cleared too: a logout is the operator saying "start over", and a
 * surviving `saml_state` makes the next login fail a state check the operator cannot see.
 */
export async function POST() {
	const cookieStore = await cookies()
	clearDashboardAuthCookie(cookieStore)
	for (const name of [...OIDC_HANDSHAKE_COOKIES, SAML_HANDSHAKE_COOKIE]) {
		cookieStore.delete(name)
	}
	return NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } })
}
