import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
	getSettings: vi.fn(),
	getProxyPools: vi.fn(),
	resolveConnectionProxyConfig: vi.fn(),
	pickProxyPoolId: vi.fn(),
}))

vi.mock("@/lib/localDb", async (importOriginal) => ({
	...(await importOriginal()),
	getProviderConnections: vi.fn(),
	getSettings: mocks.getSettings,
	getProxyPools: mocks.getProxyPools,
	validateApiKey: vi.fn(),
	updateProviderConnection: vi.fn(),
}))
vi.mock("@/lib/network/connectionProxy", () => ({
	resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
	pickProxyPoolId: mocks.pickProxyPoolId,
}))
vi.mock("@/shared/constants/providers.js", () => ({
	FREE_PROVIDERS: { opencode: { noAuth: true } },
	resolveProviderId: (provider) => provider,
}))
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }))

const { getProviderCredentials, markAccountUnavailable } = await import("@/sse/services/auth.js")

const pools = [
	{
		id: "netlify-a",
		name: "Netlify A",
		type: "netlify",
		proxyUrl: "https://netlify-a.example/relay",
	},
	{ id: "vercel-b", name: "Vercel B", type: "vercel", proxyUrl: "https://vercel-b.example" },
	{
		id: "cloudflare-c",
		name: "Cloudflare C",
		type: "cloudflare",
		proxyUrl: "https://cloudflare-c.example",
	},
]

beforeEach(() => {
	vi.clearAllMocks()
	// Rotation must be ON for the code to consider every active pool; with it off
	// the selected pool is honoured and never substituted.
	mocks.getSettings.mockResolvedValue({
		providerStrategies: { opencode: { proxyPoolId: "netlify-a", rotateStrategy: "round-robin" } },
	})
	mocks.getProxyPools.mockResolvedValue(pools)
	mocks.pickProxyPoolId.mockImplementation((ids) => ids[0])
	mocks.resolveConnectionProxyConfig.mockImplementation(({ proxyPoolId }) => {
		const proxyPool = pools.find((pool) => pool.id === proxyPoolId)
		return {
			proxyPoolId,
			proxyPool,
			source: proxyPool?.type || "none",
			connectionProxyEnabled: false,
			connectionProxyUrl: "",
			connectionNoProxy: "",
			relayUrl: proxyPool?.proxyUrl || "",
			vercelRelayUrl: proxyPool?.proxyUrl || "",
			strictProxy: true,
		}
	})
})

describe("no-auth proxy fallback", () => {
	it("tries each active pool once after a rate limit, then reports exhaustion", async () => {
		const excludedConnections = new Set()
		const excludePoolIds = new Set()
		const attemptedPoolIds = []

		for (const expectedPoolId of ["netlify-a", "vercel-b", "cloudflare-c"]) {
			const credentials = await getProviderCredentials(
				"opencode",
				excludedConnections,
				"deepseek-v4.1-flash-free",
				{ excludePoolIds },
			)

			expect(credentials.providerSpecificData.connectionProxyPoolId).toBe(expectedPoolId)
			expect(attemptedPoolIds).not.toContain(credentials.providerSpecificData.connectionProxyPoolId)
			attemptedPoolIds.push(credentials.providerSpecificData.connectionProxyPoolId)

			const result = await markAccountUnavailable(
				credentials.connectionId,
				429,
				"rate limit exceeded",
				"opencode",
				"deepseek-v4.1-flash-free",
				null,
				{ excludePoolIds, proxyPoolId: expectedPoolId },
			)
			expect(result.shouldFallback).toBe(true)
			excludedConnections.add(credentials.connectionId)
		}

		await expect(
			getProviderCredentials("opencode", excludedConnections, "deepseek-v4.1-flash-free", {
				excludePoolIds,
			}),
		).resolves.toBeNull()
		expect(attemptedPoolIds).toEqual(["netlify-a", "vercel-b", "cloudflare-c"])
	})

	it("does not repeat a direct no-auth attempt after a rate-limit session rotation", async () => {
		mocks.getSettings.mockResolvedValue({ providerStrategies: {} })
		mocks.getProxyPools.mockResolvedValue([])

		const credentials = await getProviderCredentials("opencode")
		expect(credentials.connectionId).toBe("noauth")

		const excludedConnections = new Set([credentials.connectionId])
		await expect(getProviderCredentials("opencode", excludedConnections)).resolves.toBeNull()
	})
})
