/**
 * `/api/auth/status` is the call every dashboard page makes first, and the login page branches on
 * its answer. These tests cover the two properties that used to be false:
 *
 * - the failure answer had **different keys** from the success answer, so `role`, `permissions`,
 *   `homePath` and the key fields were `undefined` when the settings read failed —
 *   indistinguishable from "this caller has no permission";
 * - a failure therefore had no honest answer to "is anyone signed in".
 *
 * `auth-status.test.ts` still covers the route; this covers the rules underneath it.
 */

import {
	type AuthStatusPort,
	readAuthStatus,
} from "9router-api/application/auth-status/read-status"
import { signedInStatus, signedOutStatus } from "9router-api/domain/auth-status"
import { describe, expect, it, vi } from "vitest"

// The dashboard stores permissions as one boolean per capability, not as a list of paths.
const FULL = { manageApiKeys: true, manageModels: true, viewUsage: true }
const BY_DEFAULT = { viewUsage: true }

const catalog = {
	full: FULL,
	byDefault: BY_DEFAULT,
	normalize: (raw: unknown) => (raw as Record<string, boolean>) ?? {},
}
const probes = { oidcConfigured: () => false, samlConfigured: () => false }

function deps(port: Partial<AuthStatusPort>) {
	return {
		port: {
			settings: async () => ({ requireLogin: true }),
			session: async () => null,
			...port,
		} as AuthStatusPort,
		probes,
		catalog,
		homePathFor: (role: string, firstAllowed: string | null) =>
			role === "apikey" ? firstAllowed : "/dashboard",
		firstAllowedPage: (permissions: object) => ("manageApiKeys" in permissions ? "/keys" : null),
	}
}

describe("the answer always has the same keys", () => {
	it("a signed-out failure answers every key the success path has", async () => {
		const failed = signedOutStatus()
		const success = await readAuthStatus(deps({}))
		expect(Object.keys(failed).sort()).toEqual(Object.keys(success).sort())
	})

	it("the failure path still names the fields the dashboard branches on", () => {
		const failed = signedOutStatus()
		// These four were the ones missing before, and each drives a branch in the UI.
		expect(failed).toHaveProperty("role")
		expect(failed).toHaveProperty("permissions")
		expect(failed).toHaveProperty("homePath")
		expect(failed).toHaveProperty("keyId")
	})
})

describe("being signed in is reported, not assumed", () => {
	it("a caller with no session is not authenticated", async () => {
		const answer = await readAuthStatus(deps({ session: async () => null }))
		// This was a real bug: the no-session path reused the signed-in builder, so a visitor with
		// no cookie was reported as authenticated: true.
		expect(answer.authenticated).toBe(false)
	})

	it("a caller with no session still gets the settings, so the login form can draw itself", async () => {
		const answer = await readAuthStatus(
			deps({ session: async () => null, settings: async () => ({ ssoType: "saml" }) }),
		)
		expect(answer.authenticated).toBe(false)
		expect(answer.ssoType).toBe("saml")
	})

	it("a caller with no session is not sent anywhere", async () => {
		const answer = await readAuthStatus(deps({ session: async () => null }))
		expect(answer.homePath).toBeNull()
	})

	it("a caller with no session is not labelled an admin", async () => {
		const answer = await readAuthStatus(deps({ session: async () => null }))
		// `EndpointPageClient` reads `role` to decide what the key form may offer. Answering
		// "admin" to a visitor would hand them the admin form.
		expect(answer.role).toBe("")
	})

	it("a caller with no session gets the default permissions, not the admin set", async () => {
		const answer = await readAuthStatus(deps({ session: async () => null }))
		expect(answer.permissions).toEqual(BY_DEFAULT)
	})
})

describe("reading settings and session", () => {
	it("a valid session reports the role and permissions the cookie carried", async () => {
		const answer = await readAuthStatus(
			deps({ session: async () => ({ role: "admin", permissions: { manageApiKeys: true } }) }),
		)
		expect(answer.authenticated).toBe(true)
		expect(answer.role).toBe("admin")
		expect(answer.permissions).toEqual({ manageApiKeys: true })
	})

	it("an admin with no permission list gets the full set", async () => {
		const answer = await readAuthStatus(deps({ session: async () => ({ role: "admin" }) }))
		expect(answer.permissions).toEqual(FULL)
	})

	it("a non-admin with no permission list does not inherit admin's", async () => {
		const answer = await readAuthStatus(deps({ session: async () => ({ role: "user" }) }))
		expect(answer.permissions).toEqual(BY_DEFAULT)
	})

	it("a key session with no usable permission gets a null home path, so the page stops", async () => {
		const answer = await readAuthStatus(
			deps({ session: async () => ({ role: "apikey", permissions: {} }) }),
		)
		// Null is load-bearing: redirecting to /dashboard here would bounce into a 403.
		expect(answer.homePath).toBeNull()
		expect(answer.loginMethod).toBe("API Key")
	})

	it("a key session with permissions lands on the first one it may open", async () => {
		const answer = await readAuthStatus(
			deps({ session: async () => ({ role: "apikey", permissions: { manageApiKeys: true } }) }),
		)
		expect(answer.homePath).toBe("/keys")
	})
})

describe("who the name says you are", () => {
	it("prefers a name the identity provider asserted over the sign-in method", async () => {
		const answer = await readAuthStatus(
			deps({ session: async () => ({ saml: true, samlName: "  Ada  ", samlEmail: "a@b" }) }),
		)
		expect(answer.displayName).toBe("Ada")
		expect(answer.loginMethod).toBe("SAML")
	})

	it("falls back to an email when no name was given", async () => {
		const answer = await readAuthStatus(
			deps({ session: async () => ({ oidc: true, oidcEmail: "a@b" }) }),
		)
		expect(answer.displayName).toBe("a@b")
	})

	it("never renders a blank name", async () => {
		for (const claims of [{}, { oidc: true }, { saml: true }, { role: "apikey" }]) {
			const answer = await readAuthStatus(deps({ session: async () => claims }))
			expect(answer.displayName.length).toBeGreaterThan(0)
		}
	})
})

describe("settings drive the login page's own presentation", () => {
	it("an empty label saved by an operator falls back to the default caption", async () => {
		const answer = await readAuthStatus(deps({ settings: async () => ({ oidcLoginLabel: "   " }) }))
		expect(answer.oidcLoginLabel).toBe("Sign in with OIDC")
	})

	it("a label the operator typed is used as typed, trimmed", async () => {
		const answer = await readAuthStatus(
			deps({ settings: async () => ({ samlLoginLabel: "  Company SSO " }) }),
		)
		expect(answer.samlLoginLabel).toBe("Company SSO")
	})

	it("`requireLogin: false` is respected rather than treated as unset", async () => {
		const answer = await readAuthStatus(deps({ settings: async () => ({ requireLogin: false }) }))
		expect(answer.requireLogin).toBe(false)
	})
})

describe("a failure closes the door instead of half-opening it", () => {
	it("settings unreadable answers signed out, not an error", async () => {
		const answer = await readAuthStatus(
			deps({
				settings: async () => {
					throw new Error("database unavailable")
				},
			}),
		)
		expect(answer.authenticated).toBe(false)
		expect(answer.requireLogin).toBe(true)
	})

	it("a failing session read answers signed out too", async () => {
		const answer = await readAuthStatus(
			deps({
				session: async () => {
					throw new Error("cookie key rotation")
				},
			}),
		)
		expect(answer.authenticated).toBe(false)
	})

	it("reports the failure without letting it escape to the caller", async () => {
		const onFailure = vi.fn()
		const d = deps({
			settings: async () => {
				throw new Error("boom")
			},
		})
		await readAuthStatus({ ...d, onFailure })
		expect(onFailure).toHaveBeenCalledTimes(1)
	})

	it("never claims a caller is signed in when nothing could be read", async () => {
		const answer = await readAuthStatus(
			deps({
				settings: async () => {
					throw new Error("boom")
				},
			}),
		)
		expect(answer.permissions).toEqual({})
		expect(answer.homePath).toBeNull()
		expect(answer.apiKey).toBeNull()
	})
})

describe("claims are untrusted", () => {
	it("ignores a token limit that is not a number", () => {
		const answer = signedInStatus({
			claims: { tokenLimit: "999999" },
			settings: {},
			probes,
			catalog,
			homePathFor: () => "/dashboard",
			firstAllowedPage: () => null,
		})
		expect(answer.tokenLimit).toBe(0)
	})

	it("ignores an endpoint list that is not a list", () => {
		const answer = signedInStatus({
			claims: { allowedEndpoints: "everything" },
			settings: {},
			probes,
			catalog,
			homePathFor: () => "/dashboard",
			firstAllowedPage: () => null,
		})
		expect(answer.allowedEndpoints).toEqual([])
	})

	it("treats an absent role as admin, which is what a password session is", () => {
		const answer = signedInStatus({
			claims: {},
			settings: {},
			probes,
			catalog,
			homePathFor: () => "/dashboard",
			firstAllowedPage: () => null,
		})
		expect(answer.role).toBe("admin")
	})
})
