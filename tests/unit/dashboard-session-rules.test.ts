import { describe, expect, test } from "vitest"
import {
	AUTH_TOKEN_COOKIE,
	handshakeComplete,
	handshakeCookieOptions,
	handshakeErrorSlug,
	OIDC_HANDSHAKE_COOKIES,
	SAML_HANDSHAKE_COOKIE,
	SESSION_COOKIES,
} from "../../apps/api/src/domain/dashboard-session"

describe("cookie names", () => {
	test("logout clears the session and the SAML state", () => {
		expect(SESSION_COOKIES).toContain(AUTH_TOKEN_COOKIE)
		expect(SESSION_COOKIES).toContain(SAML_HANDSHAKE_COOKIE)
	})

	test("the three OIDC handshake cookies are named once", () => {
		expect(OIDC_HANDSHAKE_COOKIES).toEqual(["oidc_state", "oidc_nonce", "oidc_code_verifier"])
	})
})

describe("handshakeComplete", () => {
	const good = {
		storedState: "s1",
		returnedState: "s1",
		storedNonce: "n1",
		codeVerifier: "v1",
	}

	test("a matching handshake may proceed", () => {
		expect(handshakeComplete(good)).toBe(true)
	})

	test("a mismatched state is refused", () => {
		// The state is the CSRF binding; a mismatch is an attack, not a retry.
		expect(handshakeComplete({ ...good, returnedState: "s2" })).toBe(false)
	})

	test("a missing nonce is not a degraded handshake", () => {
		// Without it the id_token's replay binding cannot be checked at all.
		expect(handshakeComplete({ ...good, storedNonce: undefined })).toBe(false)
		expect(handshakeComplete({ ...good, storedNonce: "" })).toBe(false)
	})

	test("a missing verifier is refused before any code is exchanged", () => {
		expect(handshakeComplete({ ...good, codeVerifier: null })).toBe(false)
	})

	test("a missing stored state is refused", () => {
		expect(handshakeComplete({ ...good, storedState: undefined })).toBe(false)
	})
})

describe("handshakeErrorSlug", () => {
	test("the provider's own error is forwarded", () => {
		expect(handshakeErrorSlug("access_denied", "oidc_callback_failed")).toBe("access_denied")
	})

	test("our own failure gets a fixed slug, never a raw message", () => {
		// A raw message can carry a URL or a secret into the address bar and browser history.
		expect(handshakeErrorSlug(null, "oidc_start_failed")).toBe("oidc_start_failed")
		expect(handshakeErrorSlug(undefined, "saml_acs_failed")).toBe("saml_acs_failed")
		expect(handshakeErrorSlug(new Error("boom"), "saml_acs_failed")).toBe("saml_acs_failed")
		expect(handshakeErrorSlug("", "oidc_start_failed")).toBe("oidc_start_failed")
	})
})

describe("handshakeCookieOptions", () => {
	test("always httpOnly and lax", () => {
		const options = handshakeCookieOptions(true)
		expect(options.httpOnly).toBe(true)
		expect(options.sameSite).toBe("lax")
		expect(options.path).toBe("/")
	})

	test("ten minutes, so an abandoned handshake does not linger", () => {
		expect(handshakeCookieOptions(false).maxAge).toBe(600)
	})

	test("secure follows the request", () => {
		expect(handshakeCookieOptions(true).secure).toBe(true)
		expect(handshakeCookieOptions(false).secure).toBe(false)
	})
})
