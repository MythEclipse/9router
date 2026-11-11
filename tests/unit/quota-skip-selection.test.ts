/**
 * Rotation must skip an account the quota panel already shows as spent.
 *
 * The reported case: an Antigravity account whose "Gemini (Weekly)" window reads 0% — 1,000 of
 * 1,000 used, refilling in six days — was still being handed requests, because selection only
 * learned about exhaustion from the account's own 409/429. The same is true of every provider
 * that reports quota (codebuddy, claude, codex, kimi, …): the panel knew, the request path did
 * not. These tests pin the request path to the same reading.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
	getProviderConnections: vi.fn(),
	getSettings: vi.fn(),
	resolveConnectionProxyConfig: vi.fn(),
	getUsageForProvider: vi.fn(),
	supportsUsage: vi.fn(),
}))

vi.mock("@/lib/localDb", async (importOriginal) => ({
	...(await importOriginal()),
	getProviderConnections: mocks.getProviderConnections,
	getSettings: mocks.getSettings,
	getProxyPools: vi.fn(),
	validateApiKey: vi.fn(),
	updateProviderConnection: vi.fn(),
}))
vi.mock("@/lib/network/connectionProxy", () => ({
	resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
	pickProxyPoolId: vi.fn(),
}))
vi.mock("@/shared/constants/providers.js", () => ({
	FREE_PROVIDERS: {},
	resolveProviderId: (provider: string) => provider,
}))
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }))
// The pre-flight read is exercised for real in quota-preflight.test.ts; here it must stay off the
// network so a background refresh cannot reach a provider.
vi.mock("open-sse/services/usage.js", () => ({
	getUsageForProvider: mocks.getUsageForProvider,
	supportsUsage: mocks.supportsUsage,
}))

const { clearQuotaObservations, primeQuotaObservation } = await import(
	"open-sse/services/quotaExhaustion.js"
)
const { resetQuotaPreflight } = await import("@/sse/services/quotaPreflight.js")
const { getProviderCredentials } = await import("@/sse/services/auth.js")

const NOW = new Date("2026-11-11T12:00:00.000Z")
const IN_SIX_DAYS = "2026-11-17T14:20:00.000Z"
const IN_AN_HOUR = "2026-11-11T13:00:00.000Z"

beforeEach(() => {
	vi.clearAllMocks()
	clearQuotaObservations()
	resetQuotaPreflight()
	mocks.resolveConnectionProxyConfig.mockResolvedValue({})
	mocks.getSettings.mockResolvedValue({})
	mocks.supportsUsage.mockReturnValue(true)
	mocks.getUsageForProvider.mockResolvedValue({})
})

describe("account rotation skips a quota-exhausted account", () => {
	it("skips the antigravity account whose weekly window the panel shows at 0%", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(NOW)
		try {
			mocks.getProviderConnections.mockResolvedValue([
				{ id: "ag-a", email: "ayeshapartridge@gmail.com", isActive: true },
				{ id: "ag-b", email: "second@example.com", isActive: true },
			])
			primeQuotaObservation("ag-a", "antigravity", {
				gemini_weekly: {
					name: "Gemini (Weekly)",
					used: 1000,
					total: 1000,
					remainingPercentage: 0,
					resetAt: IN_SIX_DAYS,
				},
			})

			await expect(
				getProviderCredentials("antigravity", null, "gemini-3.8-flash"),
			).resolves.toMatchObject({ connectionId: "ag-b" })
		} finally {
			vi.useRealTimers()
		}
	})

	it("skips a codebuddy account whose 5h window is spent", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(NOW)
		try {
			mocks.getProviderConnections.mockResolvedValue([
				{ id: "cb-a", email: "a@example.com", isActive: true },
				{ id: "cb-b", email: "b@example.com", isActive: true },
			])
			primeQuotaObservation("cb-a", "codebuddy-cn", {
				"5h": {
					name: "Session (5h)",
					used: 40,
					total: 40,
					remainingPercentage: 0,
					resetAt: IN_AN_HOUR,
				},
			})

			await expect(
				getProviderCredentials("codebuddy-cn", null, "claude-sonnet-5-5"),
			).resolves.toMatchObject({ connectionId: "cb-b" })
		} finally {
			vi.useRealTimers()
		}
	})

	it("reports the soonest refill when every account is spent", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(NOW)
		try {
			mocks.getProviderConnections.mockResolvedValue([
				{ id: "cb-a", email: "a@example.com", isActive: true },
				{ id: "cb-b", email: "b@example.com", isActive: true },
			])
			primeQuotaObservation("cb-a", "codebuddy-cn", {
				"5h": { used: 40, total: 40, remainingPercentage: 0, resetAt: IN_AN_HOUR },
			})
			primeQuotaObservation("cb-b", "codebuddy-cn", {
				weekly: { used: 200, total: 200, remainingPercentage: 0, resetAt: IN_SIX_DAYS },
			})

			await expect(
				getProviderCredentials("codebuddy-cn", null, "claude-sonnet-5-5"),
				// cb-a frees in an hour, cb-b in six days: the retry hint names the first account
				// that can actually serve the request again.
			).resolves.toMatchObject({ allRateLimited: true, retryAfter: IN_AN_HOUR })
		} finally {
			vi.useRealTimers()
		}
	})

	it("lets the account back in once the window has refilled", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-11-11T13:00:01.000Z"))
		try {
			mocks.getProviderConnections.mockResolvedValue([
				{ id: "cb-a", email: "a@example.com", isActive: true },
				{ id: "cb-b", email: "b@example.com", isActive: true },
			])
			primeQuotaObservation("cb-a", "codebuddy-cn", {
				"5h": { used: 40, total: 40, remainingPercentage: 0, resetAt: IN_AN_HOUR },
			})

			await expect(
				getProviderCredentials("codebuddy-cn", null, "claude-sonnet-5-5"),
			).resolves.toMatchObject({ connectionId: "cb-a" })
		} finally {
			vi.useRealTimers()
		}
	})

	it("keeps an account with quota left in rotation", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(NOW)
		try {
			mocks.getProviderConnections.mockResolvedValue([
				{ id: "cb-a", email: "a@example.com", isActive: true },
			])
			primeQuotaObservation("cb-a", "codebuddy-cn", {
				"5h": { used: 10, total: 40, remainingPercentage: 75, resetAt: IN_AN_HOUR },
			})

			await expect(
				getProviderCredentials("codebuddy-cn", null, "claude-sonnet-5-5"),
			).resolves.toMatchObject({ connectionId: "cb-a" })
		} finally {
			vi.useRealTimers()
		}
	})
})
