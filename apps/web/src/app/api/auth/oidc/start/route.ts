import { shouldUseSecureCookie } from "@9router/auth/dashboardSession"
import {
	buildOidcAuthorizationUrl,
	createOidcNonce,
	createOidcState,
	createPkcePair,
	fetchOidcDiscovery,
	getOidcRuntimeConfig,
	getPublicOrigin,
} from "@9router/auth/oidc"
import {
	handshakeCookieOptions,
	handshakeErrorSlug,
	OIDC_HANDSHAKE_COOKIES,
} from "9router-api/domain/dashboard-session"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

export async function GET(request) {
	try {
		const config = await getOidcRuntimeConfig()
		if (!config) {
			return NextResponse.redirect(
				new URL("/login?error=oidc_not_configured", getPublicOrigin(request)),
			)
		}

		const discovery = await fetchOidcDiscovery(config.issuerUrl)
		const state = createOidcState()
		const nonce = createOidcNonce()
		const { verifier, challenge } = createPkcePair()
		const redirectUri = `${getPublicOrigin(request)}/api/auth/oidc/callback`
		const authUrl = buildOidcAuthorizationUrl({
			authorizationEndpoint: discovery.authorization_endpoint,
			clientId: config.clientId,
			redirectUri,
			scopes: config.scopes,
			state,
			nonce,
			codeChallenge: challenge,
		})

		const cookieStore = await cookies()
		const options = handshakeCookieOptions(shouldUseSecureCookie(request))
		const [stateCookie, nonceCookie, verifierCookie] = OIDC_HANDSHAKE_COOKIES
		cookieStore.set(stateCookie, state, options)
		cookieStore.set(nonceCookie, nonce, options)
		cookieStore.set(verifierCookie, verifier, options)

		return NextResponse.redirect(authUrl)
	} catch (error) {
		return NextResponse.redirect(
			new URL(
				`/login?error=${encodeURIComponent(
					// Our own failure, so a fixed slug — a raw message can carry a URL or a secret
					// into the address bar and browser history.
					handshakeErrorSlug(null, "oidc_start_failed"),
				)}`,
				getPublicOrigin(request),
			),
		)
	}
}
