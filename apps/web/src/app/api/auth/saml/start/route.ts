import { shouldUseSecureCookie } from "@9router/auth/dashboardSession"
import { buildSamlAuthorizeUrl, getSamlBaseUrl, isSamlConfigured } from "@9router/auth/saml"
import {
	handshakeCookieOptions,
	handshakeErrorSlug,
	SAML_HANDSHAKE_COOKIE,
} from "9router-api/domain/dashboard-session"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { getSettings } from "@/lib/localDb"

// getSettings() reads SQLite, and `next build` prerenders every GET route it can.
// Rendering this one at build time made the build itself a database writer
// competing with the prerender workers: "SqliteError: database is locked" came
// back as a failed export and the build died, intermittently. Nothing here can
// be prerendered anyway - it reads the request cookies and redirects.
export const dynamic = "force-dynamic"

export async function GET(request) {
	const settings = await getSettings()
	const origin = getSamlBaseUrl(request, settings)
	try {
		if (!isSamlConfigured(settings)) {
			return NextResponse.redirect(new URL("/login?error=saml_not_configured", origin))
		}

		const { authorizeUrl, requestId } = await buildSamlAuthorizeUrl(request, settings)

		const cookieStore = await cookies()
		cookieStore.set(
			SAML_HANDSHAKE_COOKIE,
			requestId,
			handshakeCookieOptions(shouldUseSecureCookie(request)),
		)

		return NextResponse.redirect(authorizeUrl)
	} catch (error) {
		return NextResponse.redirect(
			new URL(
				`/login?error=${encodeURIComponent(handshakeErrorSlug(null, "saml_start_failed"))}`,
				origin,
			),
		)
	}
}
