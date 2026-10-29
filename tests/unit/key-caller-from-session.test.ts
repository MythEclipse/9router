import { describe, expect, it } from "vitest"
import { mayCreateSubKey, permissionsForSubKey } from "../../apps/api/src/domain/sub-key-scope.ts"
import {
	callerFromSession,
	isKeySession,
	PASSWORD_SESSION_ROLE,
} from "../../apps/api/src/presentation/caller-from-session.ts"

/**
 * Which caller the key rules are told they are looking at.
 *
 * The oRPC `dashboard-keys` router used to answer every request with
 * `{ role: "admin", permissions: null }`, on the reasoning that "this transport
 * authenticates with better-auth, so every caller here is a password session". True
 * of the transport that existed; false the moment the dashboard called the router
 * with an API-key session, which is what the transport work does.
 *
 * The consequence was not a wrong label. `mayCreateSubKey` returns `true` for any
 * role that is not `apikey`, so a key session without `manageApiKeys` could mint
 * keys, and `permissionsForSubKey` would hand it whatever permissions it asked for
 * instead of clamping them to the default.
 *
 * These cases fail if the constant comes back, or if the translation stops carrying
 * `role`, `apiKey` or `permissions`.
 */
const NO_PERMISSIONS = { viewUsage: false, manageApiKeys: false }
const ASKED_FOR_EVERYTHING = { viewUsage: true, manageApiKeys: true }

describe("a password session stays unrestricted", () => {
	it("may create, and its permissions are taken as given", () => {
		const caller = callerFromSession({ userId: "owner", email: "o@local" })
		expect(caller?.role).toBe(PASSWORD_SESSION_ROLE)
		expect(mayCreateSubKey(caller?.role, caller?.permissions)).toBe(true)
		expect(permissionsForSubKey(caller?.role, ASKED_FOR_EVERYTHING, NO_PERMISSIONS)).toEqual(
			ASKED_FOR_EVERYTHING,
		)
	})

	it("carries no api key, because a password user has none", () => {
		expect(callerFromSession({ userId: "owner", email: "o@local" })?.apiKey).toBeNull()
	})
})

describe("a key session keeps the limits the rules expect", () => {
	it("cannot mint keys without manageApiKeys", () => {
		const caller = callerFromSession({
			userId: "u1",
			email: "k@local",
			role: "apikey",
			apiKey: "sk-alpha",
			permissions: NO_PERMISSIONS,
		})
		expect(caller?.role).toBe("apikey")
		// The escalation the gate exists to stop, and the one the constant allowed.
		expect(mayCreateSubKey(caller?.role, caller?.permissions)).toBe(false)
	})

	it("cannot grant permissions it asks for, even when it may create", () => {
		const caller = callerFromSession({
			userId: "u1",
			email: "k@local",
			role: "apikey",
			apiKey: "sk-alpha",
			permissions: { viewUsage: true, manageApiKeys: true },
		})
		expect(mayCreateSubKey(caller?.role, caller?.permissions)).toBe(true)
		expect(permissionsForSubKey(caller?.role, ASKED_FOR_EVERYTHING, NO_PERMISSIONS)).toEqual(
			NO_PERMISSIONS,
		)
	})

	it("keeps its own key, so ownership checks have something to compare", () => {
		const caller = callerFromSession({
			userId: "u1",
			email: "k@local",
			role: "apikey",
			apiKey: "sk-alpha",
		})
		expect(caller?.apiKey).toBe("sk-alpha")
		expect(isKeySession({ userId: "u1", email: "e", role: "apikey" })).toBe(true)
	})
})

describe("the caps a caller passes on", () => {
	it("travel with the caller so a sub-key inherits them", () => {
		const caller = callerFromSession({
			userId: "u1",
			email: "k@local",
			role: "apikey",
			apiKey: "sk-alpha",
			tokenLimit: 500,
			dailyCostLimit: 2,
			allowedModels: "gpt-4o",
			allowedEndpoints: ["/v1/chat/completions"],
		})
		expect(caller?.scope).toEqual({
			tokenLimit: 500,
			dailyCostLimit: 2,
			allowedModels: "gpt-4o",
			allowedEndpoints: ["/v1/chat/completions"],
		})
	})

	it("reads a non-array endpoint list as no restriction rather than crashing", () => {
		// A malformed claim must not become a route-level exception.
		const caller = callerFromSession({
			userId: "u1",
			email: "k@local",
			role: "apikey",
			apiKey: "sk-alpha",
			allowedEndpoints: "not-a-list",
		})
		expect(caller?.scope.allowedEndpoints).toBeNull()
	})
})

describe("no session is no caller", () => {
	it("returns null instead of a permissive default", () => {
		expect(callerFromSession(null)).toBeNull()
		expect(callerFromSession(undefined)).toBeNull()
		// A permissive fallback here is precisely the defect this replaced: the old
		// constant answered `{role: "admin"}` for a caller it knew nothing about.
		expect(callerFromSession(null)?.role).toBeUndefined()
	})
})
