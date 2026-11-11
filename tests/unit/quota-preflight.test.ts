/**
 * The pre-flight read: how the request path learns what the panel already shows.
 *
 * Every rule here exists to keep an extra upstream call off the request path — cold reads are
 * awaited (selection is blind without them), warm reads happen in the background, one read per
 * connection per TTL, and any failure is fail-open.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
	getUsageForProvider: vi.fn(),
	supportsUsage: vi.fn(),
	resolveConnectionProxyConfig: vi.fn(),
}))

vi.mock("open-sse/services/usage.js", () => ({
	getUsageForProvider: mocks.getUsageForProvider,
	supportsUsage: mocks.supportsUsage,
}))
vi.mock("@/lib/network/connectionProxy", () => ({
	resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}))
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }))

const { clearQuotaObservations, findConnectionQuotaBlock, getQuotaObservation } = await import(
	"open-sse/services/quotaExhaustion.js"
)
const { ensureQuotaObservations, observeConnectionQuota, resetQuotaPreflight } = await import(
	"@/sse/services/quotaPreflight.js"
)
const { getAntigravityQuotaCache } = await import("@/sse/services/antigravityQuota.js")

const RESET_AT = "2027-01-01T00:00:00.000Z"
const SPENT = {
	"5h": { name: "Session (5h)", used: 40, total: 40, remainingPercentage: 0, resetAt: RESET_AT },
}

beforeEach(() => {
	vi.clearAllMocks()
	clearQuotaObservations()
	resetQuotaPreflight()
	getAntigravityQuotaCache().clear()
	mocks.resolveConnectionProxyConfig.mockResolvedValue({})
	mocks.supportsUsage.mockReturnValue(true)
	mocks.getUsageForProvider.mockResolvedValue({ quotas: SPENT })
})

describe("ensureQuotaObservations", () => {
	it("reads a cold connection before selection runs, and records what it found", async () => {
		await ensureQuotaObservations([{ id: "cb-a", provider: "codebuddy-cn", accessToken: "t" }])

		expect(mocks.getUsageForProvider).toHaveBeenCalledTimes(1)
		expect(mocks.getUsageForProvider.mock.calls[0][0]).toMatchObject({
			provider: "codebuddy-cn",
			accessToken: "t",
		})
		expect(findConnectionQuotaBlock("cb-a", "claude-sonnet-5-5")).toMatchObject({ resetAt: RESET_AT })
	})

	it("does not read the same connection twice inside the TTL", async () => {
		const connection = { id: "cb-a", provider: "codebuddy-cn", accessToken: "t" }
		await ensureQuotaObservations([connection])
		await ensureQuotaObservations([connection])
		expect(mocks.getUsageForProvider).toHaveBeenCalledTimes(1)
	})

	it("stays out of the way when the provider cannot report quota", async () => {
		mocks.supportsUsage.mockReturnValue(false)
		await ensureQuotaObservations([{ id: "custom", provider: "some-proxy", apiKey: "k" }])
		expect(mocks.getUsageForProvider).not.toHaveBeenCalled()
	})

	it("fails open: a broken quota endpoint does not stop the request", async () => {
		mocks.getUsageForProvider.mockRejectedValue(new Error("quota endpoint exploded"))
		await expect(
			ensureQuotaObservations([{ id: "cb-a", provider: "codebuddy-cn", accessToken: "t" }]),
		).resolves.toBeUndefined()
		expect(getQuotaObservation("cb-a")).toBeNull()
	})

	it("ignores an answer with no quotas in it", async () => {
		mocks.getUsageForProvider.mockResolvedValue({ message: "Usage API not implemented" })
		await ensureQuotaObservations([{ id: "cb-a", provider: "codebuddy-cn", accessToken: "t" }])
		expect(getQuotaObservation("cb-a")).toBeNull()
	})

	it("feeds antigravity's family-aware cache from the same read", async () => {
		mocks.getUsageForProvider.mockResolvedValue({
			quotas: {
				gemini_weekly: {
					name: "Gemini (Weekly)",
					used: 1000,
					total: 1000,
					remainingPercentage: 0,
					resetAt: RESET_AT,
				},
			},
		})
		await ensureQuotaObservations([{ id: "ag-a", provider: "antigravity", accessToken: "t" }])
		expect(getAntigravityQuotaCache().get("ag-a")?.gemini_weekly).toMatchObject({
			remainingPercentage: 0,
			resetAt: RESET_AT,
		})
	})

	it("refreshes a warm connection without holding up the request", async () => {
		const connection = { id: "cb-a", provider: "codebuddy-cn", accessToken: "t" }
		await ensureQuotaObservations([connection])
		resetQuotaPreflight("cb-a") // pretend the TTL expired
		await ensureQuotaObservations([connection])
		// The second read is in flight, not awaited — the call is still made.
		expect(mocks.getUsageForProvider).toHaveBeenCalledTimes(2)
	})
})

describe("observeConnectionQuota", () => {
	it("de-duplicates concurrent reads for one connection", async () => {
		const connection = { id: "cb-a", provider: "codebuddy-cn", accessToken: "t" }
		await Promise.all([
			observeConnectionQuota(connection),
			observeConnectionQuota(connection),
			observeConnectionQuota(connection),
		])
		expect(mocks.getUsageForProvider).toHaveBeenCalledTimes(1)
	})
})
