import { beforeEach, describe, expect, it, vi } from "vitest"

// With rotation off, the pool selector is the user's instruction. The retry
// path used to substitute a different active pool whenever the selected one had
// been excluded by an in-flight 429 — traffic then left through an IP the user
// deliberately did not choose, while the card still read "Uses the selected
// pool above". Stopping is the honest outcome.

const mocks = vi.hoisted(() => ({
	getSettings: vi.fn(),
	getProxyPools: vi.fn(),
	resolveConnectionProxyConfig: vi.fn(),
	pickProxyPoolId: vi.fn(),
}))

vi.mock("@/lib/localDb", () => ({
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
	resolveProviderId: (provider: string) => provider,
}))
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }))

const { getProviderCredentials } = await import("@/sse/services/auth.js")

const SELECTED = "pool-a-android"
const OTHER = "pool-b-vercel"

const pools = [
	{
		id: SELECTED,
		name: "Android",
		type: "http",
		proxyUrl: "http://android.local:1080",
		isActive: true,
	},
	{ id: OTHER, name: "Vercel", type: "vercel", proxyUrl: "https://vercel.example", isActive: true },
]

function pinSettings(rotateStrategy: string) {
	mocks.getSettings.mockResolvedValue({
		providerStrategies: { opencode: { proxyPoolId: SELECTED, rotateStrategy } },
	})
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.getProxyPools.mockResolvedValue(pools)
	mocks.pickProxyPoolId.mockImplementation((ids: string[]) => ids[0])
	mocks.resolveConnectionProxyConfig.mockImplementation(
		({ proxyPoolId }: { proxyPoolId: string }) => {
			const proxyPool = pools.find((pool) => pool.id === proxyPoolId)
			return {
				proxyPoolId,
				proxyPool,
				source: proxyPool?.type,
				connectionProxyEnabled: false,
				connectionProxyUrl: "",
				connectionNoProxy: "",
				relayUrl: proxyPool?.type === "vercel" ? "" : proxyPool?.proxyUrl,
				vercelRelayUrl: proxyPool?.type === "vercel" ? proxyPool?.proxyUrl : "",
				strictProxy: true,
			}
		},
	)
})

describe("selected proxy pool is honoured when rotation is off", () => {
	it("uses the selected pool, not whichever pool sits first", async () => {
		pinSettings("none")

		const credentials = await getProviderCredentials("opencode")

		expect(credentials.providerSpecificData.connectionProxyPoolId).toBe(SELECTED)
	})

	it("does not substitute another pool after the selected pool is excluded", async () => {
		pinSettings("none")
		const excludePoolIds = new Set<string>()

		const first = await getProviderCredentials("opencode", new Set(), "m", { excludePoolIds })
		expect(first.providerSpecificData.connectionProxyPoolId).toBe(SELECTED)

		excludePoolIds.add(SELECTED)
		const retry = await getProviderCredentials("opencode", new Set(), "m", { excludePoolIds })

		expect(retry?.providerSpecificData?.connectionProxyPoolId ?? null).not.toBe(OTHER)
	})

	// Rotation is the one case where using every pool is the documented promise.
	it("still rotates across pools when rotation is on", async () => {
		pinSettings("round-robin")
		mocks.getSettings.mockResolvedValue({
			providerStrategies: { opencode: { proxyPoolId: SELECTED, rotateStrategy: "round-robin" } },
		})
		mocks.pickProxyPoolId.mockImplementation((ids: string[]) => ids[0])

		const credentials = await getProviderCredentials("opencode")

		expect(mocks.pickProxyPoolId).toHaveBeenCalled()
		expect([SELECTED, OTHER]).toContain(credentials.providerSpecificData.connectionProxyPoolId)
	})
})
