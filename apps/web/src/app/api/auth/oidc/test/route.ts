import { verifyDashboardAuthToken } from "@9router/auth/dashboardSession"
import { fetchOidcDiscovery, getPublicOrigin, probeOidcClientSecret } from "@9router/auth/oidc"
import {
	isProbeRefusal,
	oidcProbeInput,
	oidcProbeOutcome,
	oidcProbeSucceeded,
	oidcRedirectUri,
	oidcSecretRejection,
	probeAccess,
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
 * POST /api/auth/oidc/test - verify an OIDC configuration without saving it.
 *
 * A rejected client secret answers 200 with `ok: false`, because the probe worked: it discovered
 * the provider and learned that the secret is wrong. See `domain/sso-probe.ts`.
 */
export async function POST(request) {
	try {
		const access = await canAccessTestRoute()
		const denial = probeAccess(access.requireLogin, access.hasValidSession)
		if (denial !== null) {
			return NextResponse.json({ error: denial.message }, { status: denial.status })
		}

		const body = await request.json().catch(() => ({}))
		const input = oidcProbeInput(body, await getSettings())
		if (isProbeRefusal(input)) {
			return NextResponse.json({ error: input.refusal.message }, { status: input.refusal.status })
		}

		const { issuerUrl, clientId, scopes, clientSecret } = input.body
		const discovery = await fetchOidcDiscovery(issuerUrl)
		const redirectUri = oidcRedirectUri(getPublicOrigin(request))
		const outcome = oidcProbeOutcome(
			await probeOidcClientSecret({
				tokenEndpoint: discovery.token_endpoint,
				clientId,
				clientSecret,
				redirectUri,
			}),
		)

		const report = {
			ok: oidcProbeSucceeded(outcome),
			discoveryOk: true,
			clientSecretTested: outcome.kind === "ok" ? outcome.tested : true,
			clientSecretValid: outcome.kind === "ok" ? outcome.valid : false,
			issuerUrl,
			clientId,
			scopes,
			redirectUri,
			authorizationEndpoint: discovery.authorization_endpoint || "",
			tokenEndpoint: discovery.token_endpoint || "",
			jwksUri: discovery.jwks_uri || "",
			...(outcome.kind === "secret-rejected"
				? { error: oidcSecretRejection(outcome.message) }
				: { message: outcome.message }),
		}
		return NextResponse.json(report)
	} catch (error) {
		return NextResponse.json({ error: error.message || "OIDC test failed" }, { status: 500 })
	}
}
