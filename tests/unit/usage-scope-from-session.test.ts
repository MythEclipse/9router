import { describe, expect, it } from "vitest"
import { usageScopeOf } from "../../apps/api/src/application/usage/report-usage.ts"
import { sessionClaimsOf } from "../../apps/web/src/lib/orpcClient.ts"

/**
 * Who may see whose usage.
 *
 * The oRPC usage router used to pass a module constant
 * `{ apiKeyFilter: null, allowedModels: "*" }` to every report. On the HTTP server
 * that was merely incomplete — every caller there is a password session, which is
 * allowed to see everything. It stopped being harmless once the dashboard called the
 * same router with an API-key session: the constant would have widened that session
 * from its own usage to every key's.
 *
 * These cases are the gate. They fail if a future change drops `apiKeyFilter` while
 * translating the dashboard session into router claims — which is exactly what the
 * first hand-written mapping in the combos route did.
 */
describe("an API-key session sees only its own usage", () => {
	it("carries apiKeyFilter through the session translation", () => {
		const claims = sessionClaimsOf({
			session: { userId: "u1", email: "a@b.c", apiKeyFilter: "key-7", allowedModels: "gpt-4o" },
		})
		// The claim must survive translation: dropping it is the bug this pins.
		expect(claims?.apiKeyFilter).toBe("key-7")
		expect(claims?.allowedModels).toBe("gpt-4o")
	})

	it("narrows a scoped session, and widens an unscoped one", () => {
		const scoped = usageScopeOf(sessionClaimsOf({ session: { userId: "u1", apiKeyFilter: "key-7" } }))
		expect(scoped).toEqual({ apiKeyFilter: "key-7", allowedModels: "*" })

		// A password session carries no filter, which means "every key".
		const password = usageScopeOf(sessionClaimsOf({ session: { userId: "owner" } }))
		expect(password).toEqual({ apiKeyFilter: null, allowedModels: "*" })
	})

	it("never invents a scope for a caller with no session", () => {
		expect(sessionClaimsOf(null)).toBeNull()
		expect(sessionClaimsOf({ session: null })).toBeNull()
		// A blank id is not a session: passing it would clear the auth gate.
		expect(sessionClaimsOf({ session: { userId: "   " } })).toBeNull()
	})
})

describe("the claims the dashboard session actually carries", () => {
	it("keeps fields it does not know about", () => {
		// The dashboard session carries role, permissions and key metadata. A
		// translation that keeps only what it recognises silently narrows what
		// procedures can decide.
		const claims = sessionClaimsOf({
			session: { userId: "u1", email: "a@b.c", role: "apikey", permissions: { read: true } },
		})
		expect(claims).toMatchObject({ role: "apikey", permissions: { read: true } })
	})

	it("falls the email back to the user id rather than leaving it undefined", () => {
		expect(sessionClaimsOf({ session: { userId: "u1" } })?.email).toBe("u1")
	})
})
