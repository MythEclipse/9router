/**
 * The four cookies a dashboard session is made of, named once.
 *
 * `logout`, the OIDC callback, the SAML ACS endpoint, and both login starters all have to agree on
 * which cookies to clear and when. A name typed in one place and mistyped in another does not fail
 * loudly: it leaves a half-session behind, and the next login start finds a stale `state` that
 * no longer matches anything.
 */

/** The session cookie itself. */
export const AUTH_TOKEN_COOKIE = "auth_token"

/** The short-lived handshake cookies. They exist only between a login start and its callback. */
export const OIDC_HANDSHAKE_COOKIES = ["oidc_state", "oidc_nonce", "oidc_code_verifier"] as const
export const SAML_HANDSHAKE_COOKIE = "saml_state"

/** Every cookie a logout has to clear, session included. */
export const SESSION_COOKIES = [AUTH_TOKEN_COOKIE, SAML_HANDSHAKE_COOKIE] as const

/**
 * Whether a handshake may proceed.
 *
 * Three cookies travel with the browser and the subject must return at least as many as it was
 * given, matching `state` exactly. A missing nonce or verifier is not a degraded handshake — it is
 * a callback that cannot be verified at all, so the honest answer is to refuse and start over
 * rather than exchange a code whose PKCE binding cannot be checked.
 */
export function handshakeComplete(input: {
	readonly storedState: string | null | undefined
	readonly returnedState: string | null | undefined
	readonly storedNonce: string | null | undefined
	readonly codeVerifier: string | null | undefined
}): boolean {
	if (!input.storedState || !input.storedNonce || !input.codeVerifier) return false
	return input.storedState === input.returnedState
}

/**
 * The `?error=` slug for a failed handshake.
 *
 * A provider `error` is forwarded verbatim so the operator sees what the IdP actually said;
 * anything else is this install's own failure and gets a fixed slug, never a raw message — a
 * message can carry a URL or a secret, and it lands in the address bar and in browser history.
 */
export function handshakeErrorSlug(providerError: unknown, fallback: string): string {
	if (typeof providerError === "string" && providerError !== "") return providerError
	return fallback
}

/** The cookie options every handshake cookie uses. */
export function handshakeCookieOptions(secure: boolean) {
	return {
		httpOnly: true,
		secure,
		sameSite: "lax" as const,
		path: "/",
		// Ten minutes: long enough to finish a login at an IdP, short enough that an abandoned
		// handshake does not linger in the browser.
		maxAge: 10 * 60,
	}
}
