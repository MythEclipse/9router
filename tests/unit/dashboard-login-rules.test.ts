import { describe, expect, test } from "vitest"
import {
	apiKeyAdmitsSession,
	apiKeyRejectionReason,
	credentialRejection,
	DEFAULT_PASSWORD_REFUSAL,
	isTunnelRequest,
	keyFingerprint,
	lockoutMessage,
	mustChangeDefaultPassword,
	permissionsPreview,
	sessionHomePath,
	ssoPasswordRefusal,
	ssoPasswordRefusalMessage,
	tunnelDashboardAllowed,
} from "../../apps/api/src/domain/dashboard-login"

describe("apiKeyAdmitsSession", () => {
	test("a valid key signs in", () => {
		expect(apiKeyAdmitsSession(true)).toBe(true)
	})

	test("an exhausted quota still signs in", () => {
		// The usage page is where the 100% bar lives; refusing the session hides that state.
		expect(apiKeyAdmitsSession("QUOTA_EXCEEDED")).toBe(true)
	})

	test("a disabled or expired key does not", () => {
		expect(apiKeyAdmitsSession("KEY_DISABLED")).toBe(false)
		expect(apiKeyAdmitsSession("KEY_EXPIRED")).toBe(false)
		expect(apiKeyAdmitsSession(false)).toBe(false)
	})

	test("an unrecognised verdict is a rejection", () => {
		// "Validity unknown" must read as "no", not as "probably fine".
		expect(apiKeyAdmitsSession("SOMETHING_NEW")).toBe(false)
		expect(apiKeyAdmitsSession("")).toBe(false)
	})
})

describe("apiKeyRejectionReason", () => {
	test("names the two specific reasons", () => {
		expect(apiKeyRejectionReason("KEY_DISABLED")).toBe("API key is disabled")
		expect(apiKeyRejectionReason("KEY_EXPIRED")).toBe("API key is expired")
	})

	test("anything else is an invalid key", () => {
		expect(apiKeyRejectionReason(false)).toBe("Invalid API key")
	})
})

describe("credentialRejection / lockoutMessage", () => {
	test("the remaining attempts are part of the answer", () => {
		// Without the count a typo and a one-away lockout look identical.
		expect(credentialRejection("Invalid password", 3)).toBe(
			"Invalid password. 3 attempt(s) left before lockout.",
		)
	})

	test("a lockout names the wait", () => {
		expect(lockoutMessage(120)).toBe("Too many failed attempts. Try again in 120s.")
	})
})

describe("isTunnelRequest", () => {
	const settings = {
		tunnelUrl: "https://abc.trycloudflare.com/hook",
		tailscaleUrl: "https://box.tailnet.ts.net",
	}

	test("the advertised tunnel host matches", () => {
		expect(isTunnelRequest("abc.trycloudflare.com", settings)).toBe(true)
		expect(isTunnelRequest("ABC.trycloudflare.com:443", settings)).toBe(true)
	})

	test("the tailscale host matches too", () => {
		expect(isTunnelRequest("box.tailnet.ts.net", settings)).toBe(true)
	})

	test("its own hostname is not a tunnel", () => {
		expect(isTunnelRequest("localhost:20128", settings)).toBe(false)
		expect(isTunnelRequest("192.168.1.4", settings)).toBe(false)
	})

	test("an unparseable setting does not throw", () => {
		// One bad settings row must not take down the login page.
		expect(isTunnelRequest("localhost", { tunnelUrl: "not a url" })).toBe(false)
		expect(isTunnelRequest("localhost", null)).toBe(false)
	})

	test("a missing host is not a tunnel", () => {
		expect(isTunnelRequest(null, settings)).toBe(false)
		expect(isTunnelRequest("", settings)).toBe(false)
	})
})

describe("tunnelDashboardAllowed", () => {
	test("only a literal true opens the tunnel", () => {
		// An untouched settings row must not be read as consent.
		expect(tunnelDashboardAllowed({ tunnelDashboardAccess: true })).toBe(true)
		expect(tunnelDashboardAllowed({ tunnelDashboardAccess: "true" })).toBe(false)
		expect(tunnelDashboardAllowed({})).toBe(false)
		expect(tunnelDashboardAllowed(null)).toBe(false)
	})
})

describe("ssoPasswordRefusal", () => {
	test("a configured SSO refuses passwords and names itself", () => {
		expect(
			ssoPasswordRefusal({ authMode: "saml", samlConfigured: true, oidcConfigured: false }),
		).toBe("saml")
		expect(
			ssoPasswordRefusal({ authMode: "oidc", samlConfigured: false, oidcConfigured: true }),
		).toBe("oidc")
	})

	test("sso mode follows ssoType", () => {
		expect(ssoPasswordRefusal({ authMode: "sso", ssoType: "saml", samlConfigured: true })).toBe(
			"saml",
		)
		expect(ssoPasswordRefusal({ authMode: "sso", ssoType: "oidc", oidcConfigured: true })).toBe(
			"oidc",
		)
	})

	test("a half-finished SSO configuration still allows passwords", () => {
		// Refusing here locks the operator out of their own dashboard with no way back in.
		expect(ssoPasswordRefusal({ authMode: "saml", samlConfigured: false })).toBe(null)
		expect(ssoPasswordRefusal({ authMode: "oidc", oidcConfigured: false })).toBe(null)
	})

	test("password mode is not an SSO refusal", () => {
		expect(ssoPasswordRefusal({ authMode: "password" })).toBe(null)
		expect(ssoPasswordRefusal({})).toBe(null)
		expect(ssoPasswordRefusal(null)).toBe(null)
	})

	test("the refusal names the method", () => {
		expect(ssoPasswordRefusalMessage("saml")).toContain("SAML SSO")
		expect(ssoPasswordRefusalMessage("oidc")).toContain("OIDC")
	})
})

describe("mustChangeDefaultPassword", () => {
	const strangerWithDefault = {
		hasStoredPassword: false,
		hasInitialPasswordOverride: false,
		trustedNetwork: false,
		allowRemoteDefaultLogin: false,
	}

	test("a remote login with the published default is refused", () => {
		expect(mustChangeDefaultPassword(strangerWithDefault)).toBe(true)
	})

	test("a changed password is never refused", () => {
		expect(mustChangeDefaultPassword({ ...strangerWithDefault, hasStoredPassword: true })).toBe(false)
	})

	test("an INITIAL_PASSWORD override is not the published default", () => {
		expect(
			mustChangeDefaultPassword({ ...strangerWithDefault, hasInitialPasswordOverride: true }),
		).toBe(false)
	})

	test("the operator's own machine or LAN is trusted", () => {
		expect(mustChangeDefaultPassword({ ...strangerWithDefault, trustedNetwork: true })).toBe(false)
	})

	test("the escape hatch allows the first remote login", () => {
		expect(mustChangeDefaultPassword({ ...strangerWithDefault, allowRemoteDefaultLogin: true })).toBe(
			false,
		)
	})

	test("the refusal explains all four ways out", () => {
		expect(DEFAULT_PASSWORD_REFUSAL).toContain("localhost")
		expect(DEFAULT_PASSWORD_REFUSAL).toContain("INITIAL_PASSWORD")
		expect(DEFAULT_PASSWORD_REFUSAL).toContain("ALLOW_REMOTE_DEFAULT_LOGIN=true")
	})
})

describe("permissionsPreview", () => {
	test("lists the granted permissions", () => {
		expect(permissionsPreview({ viewUsage: true, manageApiKeys: false })).toBe("viewUsage")
	})

	test("an empty grant says so", () => {
		expect(permissionsPreview({})).toBe("no permissions")
		expect(permissionsPreview("{}")).toBe("no permissions")
	})

	test("unparseable JSON is unknown, not empty", () => {
		// "unknown" and "none" are different facts in an audit trail.
		expect(permissionsPreview("{not json")).toBe("unknown permissions")
	})

	test("a null or array value is no permissions", () => {
		expect(permissionsPreview(null)).toBe("no permissions")
		expect(permissionsPreview([])).toBe("no permissions")
	})
})

describe("keyFingerprint", () => {
	test("shows at most eight characters", () => {
		// This row is readable from the dashboard; the full key must never be in it.
		expect(keyFingerprint("sk-1234567890abcdef")).toBe("sk-12345…")
		expect(keyFingerprint("abc")).toBe("abc…")
	})
})

describe("sessionHomePath", () => {
	test("an admin lands on the dashboard", () => {
		expect(sessionHomePath("admin", null)).toBe("/dashboard")
		expect(sessionHomePath(undefined, null)).toBe("/dashboard")
	})

	test("a key lands on its first allowed page", () => {
		expect(sessionHomePath("apikey", "/dashboard/usage")).toBe("/dashboard/usage")
	})

	test("a key with no permissions gets null, not a redirect loop", () => {
		// Redirecting to a page it cannot open bounces straight back to the login form.
		expect(sessionHomePath("apikey", null)).toBe(null)
	})

	test("an unknown role is treated as an admin session", () => {
		expect(sessionHomePath("something", null)).toBe("/dashboard")
	})
})
