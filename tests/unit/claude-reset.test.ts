/**
 * Spending a Claude limit-reset grant.
 *
 * `claude-reset-grants.test.ts` already covers `parseClaudeResetGrants` — how a grants payload is
 * summarised. What was untested is the path that *spends* one: who is allowed to, in what order the
 * refresh and the spend happen, and what upstream's answer becomes.
 *
 * A grant is irreversible — once spent it cannot be returned — so the cases below are the ways a
 * caller could spend one by accident: the wrong connection, a key session, or a retry after the
 * account already used it.
 */

import {
	type ClaudeConnection,
	type ClaudeResetPort,
	spendResetGrant,
} from "9router-api/application/claude-reset/reset-grant"
import { claudeResetEligibility, claudeResetOutcome } from "9router-api/domain/claude-reset"
import { describe, expect, it, vi } from "vitest"

const oauthConnection: ClaudeConnection = {
	id: "c1",
	provider: "claude",
	authType: "oauth",
	accessToken: "old-token",
	refreshToken: "refresh-1",
	providerSpecificData: {},
}

function port(overrides: Partial<ClaudeResetPort> = {}) {
	const calls: string[] = []
	const base: ClaudeResetPort = {
		connection: async (id) => {
			calls.push(`connection:${id}`)
			return oauthConnection
		},
		proxyOptions: async () => {
			calls.push("proxyOptions")
			return { connectionProxyEnabled: true, vercelRelayUrl: "https://relay" }
		},
		refresh: async (_connection, force) => {
			calls.push(`refresh:${force}`)
			return { connection: { ...oauthConnection, accessToken: "new-token" } }
		},
		spendGrant: async (token, grantId) => {
			calls.push(`spendGrant:${String(token)}:${String(grantId)}`)
			return { ok: true, status: 200 }
		},
	}
	return Object.assign({ ...base, ...overrides }, { calls })
}

describe("who may spend a grant", () => {
	it("refuses a missing connection with 404, not 400", async () => {
		const p = port({ connection: async () => null })
		const answer = await spendResetGrant("nope", undefined, p)
		expect(answer.status).toBe(404)
		expect((answer.body as { error: string }).error).toBe("Connection not found")
	})

	it("refuses a non-Claude provider before refreshing the token", async () => {
		const p = port({ connection: async () => ({ ...oauthConnection, provider: "codex" }) })
		const answer = await spendResetGrant("c1", undefined, p)
		expect(answer.status).toBe(400)
		// A wrong connection must not cost a refresh on the way to being told no.
		expect(p.calls.some((c) => c.startsWith("refresh"))).toBe(false)
		expect(p.calls.some((c) => c.startsWith("spendGrant"))).toBe(false)
	})

	it("refuses a Claude API-key connection: there is no session to reset", async () => {
		const p = port({ connection: async () => ({ ...oauthConnection, authType: "apikey" }) })
		const answer = await spendResetGrant("c1", undefined, p)
		expect(answer.status).toBe(400)
		expect(p.calls.some((c) => c.startsWith("spendGrant"))).toBe(false)
	})

	it("accepts only a Claude oauth row", () => {
		expect(claudeResetEligibility(oauthConnection).ok).toBe(true)
		expect(claudeResetEligibility({ provider: "claude", authType: "access_token" }).ok).toBe(false)
		expect(claudeResetEligibility(null).ok).toBe(false)
	})
})

describe("spending", () => {
	it("refreshes before spending, so upstream sees a live token", async () => {
		const p = port()
		await spendResetGrant("c1", "grant-9", p)
		const order = p.calls.filter((c) => c.startsWith("refresh") || c.startsWith("spendGrant"))
		expect(order[0]?.startsWith("refresh")).toBe(true)
	})

	it("spends with the refreshed token and the caller's grant id", async () => {
		const p = port()
		await spendResetGrant("c1", "grant-9", p)
		expect(p.calls).toContain("spendGrant:new-token:grant-9")
	})

	it("passes undefined through when no grant id was given", async () => {
		const p = port()
		await spendResetGrant("c1", undefined, p)
		expect(p.calls).toContain("spendGrant:new-token:undefined")
	})

	it("fills the four proxy fields with the old defaults", async () => {
		let seen: Record<string, unknown> = {}
		const p = port({
			spendGrant: async (_token, _id, proxyOptions) => {
				seen = proxyOptions
				return { ok: true }
			},
		})
		await spendResetGrant("c1", undefined, p)
		expect(seen).toEqual({
			connectionProxyEnabled: true,
			connectionProxyUrl: "",
			connectionNoProxy: "",
			vercelRelayUrl: "https://relay",
			strictProxy: false,
		})
	})

	it("answers 500 with the reason when the refresh throws", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const p = port({
			refresh: async () => {
				throw new Error("refresh denied")
			},
		})
		const answer = await spendResetGrant("c1", undefined, p)
		expect(answer.status).toBe(500)
		expect((answer.body as { error: string }).error).toBe("refresh denied")
		warn.mockRestore()
	})
})

describe("what upstream's answer becomes", () => {
	it("a success is a 200 carrying upstream's body", () => {
		const outcome = claudeResetOutcome({ ok: true, status: 200, granted: 1 })
		expect(outcome.status).toBe(200)
		expect(outcome.body).toEqual({ ok: true, status: 200, granted: 1 })
	})

	it("a 4xx is forwarded as it stands: it is the caller's to fix", () => {
		expect(claudeResetOutcome({ ok: false, status: 403, reason: "forbidden" }).status).toBe(403)
	})

	it("anything else becomes 409: a conflict with the account, not a server fault", () => {
		for (const status of [200, 500, undefined, "weird"]) {
			expect(claudeResetOutcome({ ok: false, status, reason: "already_used" }).status).toBe(409)
		}
	})

	it("never leaves the message blank, because the dashboard renders it directly", () => {
		expect(claudeResetOutcome({ ok: false }).body.message).toBe("Reset not applied: unknown")
	})

	it("keeps upstream's own message when it gave one", () => {
		expect(claudeResetOutcome({ ok: false, message: "Grant already spent" }).body.message).toBe(
			"Grant already spent",
		)
	})

	it("falls back to `result` when there is no `reason`", () => {
		expect(claudeResetOutcome({ ok: false, result: "no_grants" }).body.message).toBe(
			"Reset not applied: no_grants",
		)
	})
})
