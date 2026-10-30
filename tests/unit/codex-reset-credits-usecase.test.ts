/**
 * The Codex reset-credit flow, tested through its port.
 *
 * Two files already exist: `codex-reset-credits-rules.test.ts` covers the domain's own rules, and
 * `codex-reset-credits.test.ts` covers the route. Neither covers the *sequence* — and that
 * sequence used to exist twice, once in `GET` and once in `POST`, which is exactly the duplication
 * that drifts without a test noticing. The two retry paths had no coverage at all, because
 * reaching them needed a live OAuth provider.
 */

import {
	type CodexConnection,
	type CodexResetPort,
	readResetCredits,
	redeemResetCredit,
} from "9router-api/application/codex-reset-credits/reset-credits"
import { describe, expect, it, vi } from "vitest"

const eligible: CodexConnection = {
	id: "c1",
	provider: "codex",
	authType: "oauth",
	accessToken: "old-token",
	refreshToken: "refresh-1",
	providerSpecificData: {},
}

function port(overrides: Partial<CodexResetPort> = {}) {
	const calls: string[] = []
	const base: CodexResetPort = {
		connection: async (id) => {
			calls.push(`connection:${id}`)
			return eligible
		},
		proxyOptions: async () => {
			calls.push("proxyOptions")
			return {}
		},
		refresh: async (_connection, force) => {
			calls.push(`refresh:${force}`)
			return { connection: { ...eligible, accessToken: "new-token" } }
		},
		readCredits: async (token) => {
			calls.push(`readCredits:${String(token)}`)
			return { available: 2 }
		},
		redeemCredit: async (token, requestId) => {
			calls.push(`redeemCredit:${String(token)}:${requestId}`)
			return { redeemed: 1 }
		},
		newRequestId: () => {
			calls.push("newRequestId")
			return "req-1"
		},
	}
	return Object.assign({ ...base, ...overrides }, { calls })
}

describe("reading credits", () => {
	it("refuses an unknown connection before refreshing anything", async () => {
		const p = port({ connection: async () => null })
		const answer = await readResetCredits("nope", p)
		expect(answer.status).not.toBe(200)
		expect(p.calls.some((c) => c.startsWith("refresh"))).toBe(false)
	})

	it("refreshes before the upstream call when the connection is OAuth", async () => {
		const p = port()
		await readResetCredits("c1", p)
		const order = p.calls.filter((c) => c.startsWith("refresh") || c.startsWith("readCredits"))
		expect(order[0]?.startsWith("refresh")).toBe(true)
	})

	it("calls upstream with the refreshed token, not the stale one", async () => {
		const p = port()
		await readResetCredits("c1", p)
		expect(p.calls).toContain("readCredits:new-token")
	})

	it("answers 401 when the refresh fails, rather than blaming the server", async () => {
		const p = port({
			refresh: async () => {
				throw new Error("refresh denied")
			},
		})
		const answer = await readResetCredits("c1", p)
		expect(answer.status).toBe(401)
		expect((answer.body as { error: string }).error).toContain("refresh denied")
	})

	it("retries once after an expired credential", async () => {
		let first = true
		const p = port({
			readCredits: async (token) => {
				if (first) {
					first = false
					throw new Error("token expired")
				}
				return { available: 2 }
			},
		})
		const answer = await readResetCredits("c1", p)
		expect(answer.status).toBe(200)
		expect(p.calls.filter((c) => c.startsWith("refresh"))).toHaveLength(2)
	})

	it("does not force a retry for an ordinary upstream failure", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const p = port({
			readCredits: async () => {
				throw new Error("connection reset by peer")
			},
		})
		const answer = await readResetCredits("c1", p)
		expect(answer.status).toBe(500)
		// One refresh for the OAuth prepare, and no forced second one.
		expect(p.calls.filter((c) => c === "refresh:true")).toHaveLength(0)
		warn.mockRestore()
	})
})

describe("redeeming a credit", () => {
	it("mints the redeem id server-side, never from the caller", async () => {
		const p = port()
		await redeemResetCredit("c1", p)
		expect(p.calls).toContain("newRequestId")
		expect(p.calls).toContain("redeemCredit:new-token:req-1")
	})

	it("keeps the first upstream answer when the retry itself fails", async () => {
		// The first answer is still the truthful one; replacing it with the refresh's failure
		// would report the wrong problem to the operator.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		let redeems = 0
		const p = port({
			redeemCredit: async () => {
				redeems += 1
				return { error: "token expired" }
			},
			refresh: async (_connection, force) => {
				if (force) throw new Error("refresh dead")
				return { connection: { ...eligible, accessToken: "new-token" } }
			},
		})
		const answer = await redeemResetCredit("c1", p)
		expect(redeems).toBe(1)
		expect(answer.status).not.toBe(500)
		warn.mockRestore()
	})

	it("answers 401 when the prepare refresh fails", async () => {
		const p = port({
			refresh: async () => {
				throw new Error("refresh denied")
			},
		})
		const answer = await redeemResetCredit("c1", p)
		expect(answer.status).toBe(401)
	})

	it("answers 500, not a throw, when reading the connection blows up", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const p = port({
			connection: async () => {
				throw new Error("db down")
			},
		})
		const answer = await redeemResetCredit("c1", p)
		expect(answer.status).toBe(500)
		expect((answer.body as { error: string }).error).toBe("db down")
		warn.mockRestore()
	})
})
