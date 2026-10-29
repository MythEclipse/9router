import { verifyDashboardAuthToken } from "@9router/auth/dashboardSession"
import { formatX509Certificate } from "@9router/auth/saml"
import {
	isProbeRefusal,
	probeAccess,
	samlEndpoints,
	samlProbeInput,
} from "9router-api/domain/sso-probe"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { getSettings } from "@/lib/localDb"

export const dynamic = "force-dynamic"

/** Open when the dashboard is public by choice; otherwise a session is required. */
async function canAccessTestRoute(): Promise<{ requireLogin: boolean; hasValidSession: boolean }> {
	const settings = await getSettings()
	const requireLogin = settings.requireLogin !== false
	if (!requireLogin) return { requireLogin, hasValidSession: false }
	const cookieStore = await cookies()
	return {
		requireLogin,
		hasValidSession: await verifyDashboardAuthToken(cookieStore.get("auth_token")?.value),
	}
}

/**
 * POST /api/auth/saml/test - verify a SAML configuration without saving it.
 *
 * Reports only; the operator saves separately. Every ordering rule lives in
 * `domain/sso-probe.ts`: which gate applies, blank-vs-cleared fields, and why the entry point is
 * checked before the certificate.
 */
export async function POST(request) {
	try {
		const access = await canAccessTestRoute()
		const denial = probeAccess(access.requireLogin, access.hasValidSession)
		if (denial !== null) {
			return NextResponse.json({ error: denial.message }, { status: denial.status })
		}

		const body = await request.json().catch(() => ({}))
		const input = samlProbeInput(body, await getSettings())
		if (isProbeRefusal(input)) {
			return NextResponse.json({ error: input.refusal.message }, { status: input.refusal.status })
		}

		if (!formatX509Certificate(input.body.certificate)) {
			return NextResponse.json({ error: "Invalid IdP X.509 Certificate format" }, { status: 400 })
		}

		const { acsUrl, metadataUrl } = samlEndpoints(new URL(request.url).origin)
		return NextResponse.json({
			ok: true,
			samlEntryPoint: input.body.entryPoint,
			samlIssuer: input.body.issuer,
			certValid: true,
			acsUrl,
			metadataUrl,
			message: "SAML 2.0 configuration verified successfully.",
		})
	} catch (error) {
		return NextResponse.json({ error: error.message || "SAML test failed" }, { status: 500 })
	}
}
