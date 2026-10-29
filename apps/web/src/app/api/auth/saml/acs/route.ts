import { setDashboardAuthCookie } from "@9router/auth/dashboardSession"
import { checkLock, getClientIp, recordFail, recordSuccess } from "@9router/auth/loginLimiter"
import {
	getSamlBaseUrl,
	isSamlConfigured,
	pickSamlDisplayName,
	pickSamlEmail,
	validateSamlResponse,
} from "@9router/auth/saml"
import { lockoutMessage } from "9router-api/domain/dashboard-login"
import { handshakeErrorSlug, SAML_HANDSHAKE_COOKIE } from "9router-api/domain/dashboard-session"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { getSettings } from "@/lib/localDb"

export const dynamic = "force-dynamic"

export async function POST(request) {
	const settings = await getSettings()
	const origin = getSamlBaseUrl(request, settings)
	const ip = getClientIp(request)

	const lock = checkLock(ip)
	if (lock.locked) {
		return NextResponse.redirect(
			new URL(`/login?error=${encodeURIComponent(lockoutMessage(lock.retryAfter))}`, origin),
		)
	}

	const cookieStore = await cookies()
	const storedRequestId = cookieStore.get(SAML_HANDSHAKE_COOKIE)?.value || ""

	// Always clear saml_state cookie after attempt
	cookieStore.delete(SAML_HANDSHAKE_COOKIE)

	try {
		const formData = await request.formData()
		const SAMLResponse = formData.get("SAMLResponse")

		if (!SAMLResponse) {
			recordFail(ip)
			return NextResponse.redirect(new URL("/login?error=saml_missing_response", origin))
		}

		if (!isSamlConfigured(settings)) {
			recordFail(ip)
			return NextResponse.redirect(new URL("/login?error=saml_not_configured", origin))
		}

		const profile = await validateSamlResponse(request, { SAMLResponse }, storedRequestId, settings)

		const samlEmail = pickSamlEmail(profile, settings) || null
		const samlName = pickSamlDisplayName(profile, settings) || "SAML user"

		recordSuccess(ip)

		await setDashboardAuthCookie(cookieStore, request, {
			saml: true,
			samlEmail,
			samlName,
		})

		return NextResponse.redirect(new URL("/dashboard", origin))
	} catch (error) {
		recordFail(ip)
		return NextResponse.redirect(
			new URL(
				`/login?error=${encodeURIComponent(handshakeErrorSlug(null, "saml_acs_failed"))}`,
				origin,
			),
		)
	}
}
