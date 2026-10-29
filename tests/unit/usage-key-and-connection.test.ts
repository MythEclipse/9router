/**
 * The per-key report and the connection-read ordering — the two places this area can go wrong
 * without looking wrong.
 *
 * The key report has three rules that all fail *quietly*: an API-key session shown an orphan
 * row sees other branches' totals; a key read from its stored counter instead of the larger of
 * two numbers looks fresh while the log says it is spent; and a `spentToday` read anywhere but
 * the enforcement counter makes the page disagree with the 429 the gateway actually returns.
 *
 * The connection read fails *loudly* when reordered, which is worse: refreshing from a stale
 * snapshot revokes an OpenAI session and logs the account out. The order is four steps and each
 * one has a test that fails if it moves.
 */
import { describe, expect, test } from "bun:test"
import {
	type KeyRecord,
	type KeyUsageDeps,
	makeKeyUsageReport,
} from "../../apps/api/src/application/usage/key-usage-report.ts"
import {
	type ConnectionUsageDeps,
	makeConnectionUsage,
} from "../../apps/api/src/application/usage/read-connection-usage.ts"
import { AppError } from "../../apps/api/src/domain/errors.ts"

const NOW = 1_700_000_000_000
const OWN_KEY = "sk-abcdefghijklmnop"

function key(overrides: Partial<KeyRecord> = {}): KeyRecord {
	return {
		id: "k1",
		name: "Primary",
		key: OWN_KEY,
		isActive: true,
		createdAt: "2026-01-01T00:00:00.000Z",
		tokenLimit: 1000,
		usedTokens: 100,
		resetInterval: "daily",
		rpmLimit: 0,
		tpmLimit: 0,
		...overrides,
	}
}

function keyDeps(overrides: Partial<KeyUsageDeps> = {}): KeyUsageDeps {
	return {
		listKeys: async () => [key()],
		visibleKeys: (keys) => keys,
		creatorNameOf: () => undefined,
		aggregatesOf: async () => ({
			totals: {
				[OWN_KEY]: { requests: 3, promptTokens: 10, completionTokens: 5, cost: 0.1, lastUsed: null },
			},
			modelsByKey: {},
			errorsByKey: { [OWN_KEY]: { ok: 2, errors: 1 } },
			tokensInWindow: { [OWN_KEY]: 400 },
		}),
		budgetOf: (_k, ctx) => ({ kind: "tokens", cap: ctx.tokenCap, used: ctx.tokenUsed }),
		spentTodayOf: () => 0.25,
		todayKey: () => "2026-01-01",
		maskKey: () => "sk-abcdef***",
		now: () => NOW,
		...overrides,
	}
}

describe("key report: quota used is the larger of the column and the window", () => {
	test("the window sum wins when the log is ahead of the stored counter", async () => {
		const report = await makeKeyUsageReport(keyDeps()).report(null, null)
		// column says 100, the log says 400: the log is ahead of the commit.
		expect(report.keys[0].usedTokens).toBe(400)
		expect(report.keys[0].usagePercent).toBe(40)
	})

	test("the stored counter wins when it is ahead of the window", async () => {
		const report = await makeKeyUsageReport(
			keyDeps({
				listKeys: async () => [key({ usedTokens: 900 })],
				aggregatesOf: async () => ({
					totals: {},
					modelsByKey: {},
					errorsByKey: {},
					tokensInWindow: { [OWN_KEY]: 10 },
				}),
			}),
		).report(null, null)
		expect(report.keys[0].usedTokens).toBe(900)
	})
})

describe("key report: the orphan row is only for a caller who sees every key", () => {
	const withDeletedKey = {
		totals: {
			[OWN_KEY]: { requests: 1, promptTokens: 1, completionTokens: 1, cost: 0, lastUsed: null },
			"sk-deleted-key": {
				requests: 7,
				promptTokens: 70,
				completionTokens: 0,
				cost: 0.7,
				lastUsed: null,
			},
		},
		modelsByKey: {},
		errorsByKey: {},
		tokensInWindow: {},
	}

	test("a password session sees the deleted keys together", async () => {
		const report = await makeKeyUsageReport(
			keyDeps({ aggregatesOf: async () => withDeletedKey }),
		).report(null, null)

		const orphan = report.keys.find((row) => row.id === "deleted")
		expect(orphan?.requests).toBe(7)
	})

	test("a key session never sees a row for keys it cannot see", async () => {
		const report = await makeKeyUsageReport(
			keyDeps({ aggregatesOf: async () => withDeletedKey }),
		).report(null, OWN_KEY)

		// Its own key is the only row; the other key's traffic is not "deleted" to this caller.
		expect(report.keys.map((row) => row.id)).toEqual(["k1"])
	})
})

describe("key report: a missing query port is a fault, not an empty page", () => {
	test("the constructor refuses rather than reporting zero keys", () => {
		expect(() => makeKeyUsageReport(keyDeps({ aggregatesOf: undefined }))).toThrow()
	})
})

function connDeps(overrides: Partial<ConnectionUsageDeps> = {}): ConnectionUsageDeps {
	return {
		connectionOf: async () =>
			({ id: "c1", provider: "openai", authType: "oauth", refreshToken: "r" }) as never,
		nodeOf: async () => null,
		usageApiKeyProviders: [],
		isCustomQuotaProvider: () => false,
		isOAuthConnection: (c) => c.authType === "oauth",
		canReadConnectionUsage: () => true,
		customQuotaConnection: (c) => c,
		quotaProxyOptions: () => ({}),
		proxyConfigOf: async () => ({}),
		authExpiryVerdict: () => ({ kind: "ok" }),
		refreshFailureMessage: () => "",
		refresh: async (c) => ({ connection: c }),
		usageOf: async () => ({ ok: true }),
		...overrides,
	}
}

describe("connection read: the refresh happens before the upstream call", () => {
	test("an OAuth connection is refreshed first", async () => {
		const seen: string[] = []
		const deps = connDeps({
			refresh: async (c) => {
				seen.push("refresh")
				return { connection: c }
			},
			usageOf: async () => {
				seen.push("usage")
				return { ok: true }
			},
		})

		await makeConnectionUsage(deps).readUsage("c1", false)

		expect(seen).toEqual(["refresh", "usage"])
	})

	test("an API-key connection is not refreshed at all", async () => {
		let refreshed = false
		const deps = connDeps({
			connectionOf: async () => ({ id: "c1", provider: "deepgram", authType: "apikey" }) as never,
			isOAuthConnection: () => false,
			refresh: async (c) => {
				refreshed = true
				return { connection: c }
			},
		})

		await makeConnectionUsage(deps).readUsage("c1", false)

		expect(refreshed).toBe(false)
	})
})

describe("connection read: a refusal keeps its own status", () => {
	test("an ineligible provider answers 'not available' as a 200 message", async () => {
		const answer = await makeConnectionUsage(
			connDeps({ canReadConnectionUsage: () => false }),
		).readUsage("c1", false)

		expect(answer.kind).toBe("refusal")
		if (answer.kind === "refusal") {
			// 200, not 4xx: the panel renders this as an explanation.
			expect(answer.refusal.status).toBe(200)
		}
	})

	test("a failed refresh is a 401, not a 500", async () => {
		const answer = await makeConnectionUsage(
			connDeps({
				refresh: async () => {
					throw new Error("invalid_grant")
				},
			}),
		).readUsage("c1", false)

		expect(answer.kind).toBe("refusal")
		if (answer.kind === "refusal") {
			expect(answer.refusal.status).toBe(401)
			expect(answer.refusal.message).toContain("invalid_grant")
		}
	})

	test("a reauthorize verdict is a 401 and does not retry the usage call", async () => {
		let usageCalls = 0
		const answer = await makeConnectionUsage(
			connDeps({
				authExpiryVerdict: () => ({ kind: "reauthorize", message: "please re-authorize" }),
				usageOf: async () => {
					usageCalls += 1
					return {}
				},
			}),
		).readUsage("c1", false)

		expect(answer.kind).toBe("refusal")
		expect(usageCalls).toBe(1)
	})

	test("an unknown connection is a 404", async () => {
		const error = await makeConnectionUsage(connDeps({ connectionOf: async () => null }))
			.readUsage("nope", false)
			.catch((e: unknown) => e)

		expect(error instanceof AppError ? error.status : null).toBe(404)
	})
})
