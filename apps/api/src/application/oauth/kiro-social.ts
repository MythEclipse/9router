import {
	type KiroSocialExchangeInput,
	kiroExpiryFrom,
	kiroSocialLabels,
	readKiroSocialExchange,
	readKiroSocialProvider,
} from "../../domain/kiro-social.ts"

/**
 * Kiro's social sign-in, in two steps.
 *
 * Authorize hands the browser a URL and the verifier it must send back; exchange turns the
 * returned code into tokens and a connection row. The verifier travels through the client
 * because the callback arrives on a custom protocol the server never sees.
 */

/** The token response Kiro's exchange returns, as this layer needs it. */
export interface KiroSocialTokens {
	readonly accessToken: string
	readonly refreshToken: string
	readonly expiresIn: number
	readonly profileArn: string
}

/**
 * What the authorize step needs. Split from the exchange deps so neither step has to supply
 * a function it never calls — a `throw new Error("not used")` stub in a route is a trap for
 * whoever wires the next provider.
 */
export interface KiroAuthorizeDeps {
	readonly generatePkce: () => {
		codeVerifier: string
		codeChallenge: string
		state: string
	}
	readonly buildLoginUrl: (provider: string, codeChallenge: string, state: string) => string
}

/** What the exchange step needs. */
export interface KiroExchangeDeps {
	readonly exchangeCode: (code: string, codeVerifier: string) => Promise<KiroSocialTokens>
	readonly emailFromToken: (accessToken: string) => string | null
	readonly createConnection: (input: Record<string, unknown>) => Promise<{
		id: string
		provider?: string
		email?: string | null
	}>
	readonly now: () => number
}

export interface KiroSocialAnswer {
	readonly ok: boolean
	readonly status: number
	readonly body: Record<string, unknown>
}

/**
 * `GET /api/oauth/kiro/social-authorize?provider=google|github`.
 *
 * The verifier and state are answered to the client on purpose: the client pastes back the
 * callback URL, so it has to hold them across the trip the server cannot observe.
 */
export function authorizeKiroSocial(
	providerQuery: string | null,
	deps: KiroAuthorizeDeps,
): KiroSocialAnswer {
	const provider = readKiroSocialProvider(
		providerQuery,
		"Invalid provider. Use 'google' or 'github'",
	)
	if (!provider.ok || !provider.provider) {
		return { ok: false, status: 400, body: { error: provider.error } }
	}

	const pkce = deps.generatePkce()
	return {
		ok: true,
		status: 200,
		body: {
			authUrl: deps.buildLoginUrl(provider.provider, pkce.codeChallenge, pkce.state),
			state: pkce.state,
			codeVerifier: pkce.codeVerifier,
			codeChallenge: pkce.codeChallenge,
			provider: provider.provider,
		},
	}
}

/**
 * `POST /api/oauth/kiro/social-exchange` — { code, codeVerifier, provider }.
 *
 * The connection is only written after the exchange answered tokens, so a refused code leaves
 * no row behind. The email is best-effort: it is read from the token's own claims, and a
 * provider that omits it still yields a usable connection.
 */
export async function exchangeKiroSocial(
	body: unknown,
	deps: KiroExchangeDeps,
): Promise<KiroSocialAnswer> {
	const parsed = readKiroSocialExchange(body)
	if (!parsed.ok || !parsed.input) {
		return { ok: false, status: 400, body: { error: parsed.error } }
	}

	try {
		return { ok: true, status: 200, body: await connectedRow(parsed.input, deps) }
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error"
		return { ok: false, status: 500, body: { error: message } }
	}
}

async function connectedRow(input: KiroSocialExchangeInput, deps: KiroExchangeDeps) {
	const tokens = await deps.exchangeCode(input.code, input.codeVerifier)
	const labels = kiroSocialLabels(input.provider)

	const connection = await deps.createConnection({
		provider: "kiro",
		authType: "oauth",
		accessToken: tokens.accessToken,
		refreshToken: tokens.refreshToken,
		expiresAt: kiroExpiryFrom(tokens.expiresIn, deps.now()),
		email: deps.emailFromToken(tokens.accessToken) || null,
		providerSpecificData: {
			profileArn: tokens.profileArn,
			authMethod: labels.authMethod,
			provider: labels.provider,
		},
		testStatus: "active",
	})

	return {
		success: true,
		connection: {
			id: connection.id,
			provider: connection.provider,
			email: connection.email,
		},
	}
}
