import { clearDashboardAuthCookie } from "@9router/auth/dashboardSession"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

export async function POST() {
	const cookieStore = await cookies()
	clearDashboardAuthCookie(cookieStore)
	cookieStore.delete("oidc_state")
	cookieStore.delete("oidc_nonce")
	cookieStore.delete("oidc_code_verifier")
	return NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } })
}
