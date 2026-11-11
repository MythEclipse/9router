// Route-level acceptance for CommandCode live-model discovery:
//   GET /api/providers/[id]/models  →  vendor catalog  →  UI rows
// The catalog URL is public, but the route still requires a seeded connection.
//
// The local route is a delegation to the listProviderModels use case, and this
// suite cannot open the SQLite handle (createDb refuses under Vitest), so the
// connection store is stubbed. Everything the test is about — the catalogue
// resolver, the CommandCode identity headers, the hidden-alias filter, the
// static-catalogue fallback and the /v1/models projection — runs for real.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const CATALOG_URL = "https://api.commandcode.ai/provider/v1/models?view=client"

type StubCall = { url: string; headers: Record<string, string> }

const stub = vi.hoisted(() => ({
	mode: "ok",
	calls: [] as StubCall[],
	catalog: null as unknown,
}))

const store = vi.hoisted(() => new Map<string, Record<string, unknown>>())

const db = vi.hoisted(() => ({
	find: vi.fn(),
	getProviderConnections: vi.fn(),
	getCombos: vi.fn(async () => []),
	getCustomModels: vi.fn(async () => []),
	getModelAliases: vi.fn(async () => ({})),
	getStudioModels: vi.fn(async () => []),
}))

stub.catalog = {
	catalogVersion: "catalog-abc123",
	object: "list",
	refreshAfterSeconds: 900,
	data: [
		{
			id: "claude-sonnet-5-5",
			name: "Claude Sonnet 5.5",
			context_length: 1000000,
			inputModalities: ["text", "image"],
			reasoningEfforts: ["low", "medium", "high"],
			display: { label: "Claude Sonnet 5.5", description: "best combo of speed & intelligence" },
		},
		{
			id: "deepseek/deepseek-v4.1-flash-fast",
			name: "DeepSeek V4.1 Flash Fast",
			context_length: 1000000,
			maxOutputTokens: 262144,
			inputModalities: ["text"],
			reasoningEfforts: null,
			display: {
				label: "DeepSeek V4.1 Flash Fast (latest)",
				description: "High throughput V4.1 Flash",
			},
		},
		{
			id: "stealth/glyph-cluster:free",
			hidden: true,
			context_length: 256000,
			inputModalities: ["text"],
			reasoningEfforts: ["high"],
			display: { label: "Glyph Cluster" },
		},
	],
}

vi.mock("@/lib/localDb", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getProviderConnections: db.getProviderConnections,
	getCombos: db.getCombos,
	getCustomModels: db.getCustomModels,
	getModelAliases: db.getModelAliases,
	getStudioModels: db.getStudioModels,
}))

vi.mock("@/lib/disabledModelsDb", () => ({
	getDisabledModels: vi.fn(async () => ({})),
}))

beforeEach(() => {
	stub.mode = "ok"
	stub.calls.length = 0
	store.clear()
	db.find.mockImplementation(async (id: string) => store.get(id) ?? null)
	db.getProviderConnections.mockImplementation(async () => Array.from(store.values()))
	// Install AFTER the module graph is imported: open-sse's proxy layer assigns
	// globalThis.fetch at import time, so a stub installed earlier would be replaced.
	vi.stubGlobal("fetch", async (url: string, options?: { headers?: Record<string, string> }) => {
		const href = String(url)
		stub.calls.push({ url: href, headers: options?.headers || {} })
		if (href !== CATALOG_URL) return new Response("unexpected url", { status: 404 })
		if (stub.mode === "error") return new Response("boom", { status: 500 })
		return Response.json(stub.catalog)
	})
})

afterEach(() => {
	vi.unstubAllGlobals()
})

const { makeListProviderModels } = await import(
	"../../apps/api/src/application/providers/list-provider-models.ts"
)
const modelsHost = await import("@/lib/providerModelsHost")
const host = await import("@/lib/providerConnectionHost")

const listProviderModelsUseCase = makeListProviderModels({
	connections: {
		find: async (id) => (await db.find(id)) ?? null,
	},
	catalogue: {
		...host.providerCatalogue,
		modelListAdapter: modelsHost.modelListAdapter,
	},
	fetchModels: modelsHost.fetchModels,
	resolveCustom: modelsHost.resolveCustomModels,
})

vi.doMock("@/lib/useCases", () => ({
	getUseCases: () => ({ listProviderModels: listProviderModelsUseCase }),
}))

// The route reaches its procedures through the in-process client, which carries
// the dashboard session. There is no Next request scope in a unit test, so the
// session is part of the wiring faked here rather than something the route can
// look up.
vi.doMock("@9router/auth/dashboardPermissions", () => ({
	getSessionContext: async () => ({
		session: { userId: "owner-1", email: "owner@local", role: "admin" },
		permissions: [],
		apiKeyFilter: null,
	}),
}))

const { GET } = await import("../../apps/web/src/app/api/providers/[id]/models/route.js")

async function seedCommandCode(n: string) {
	const connection = {
		id: `commandcode-live-${n}`,
		provider: "commandcode",
		authType: "apikey",
		name: `commandcode-live-${n}-${Date.now()}`,
		apiKey: `user_live_${n}_secret`,
		testStatus: "active",
		isActive: true,
	}
	store.set(connection.id, connection)
	return connection
}

async function getModels(connectionId: string) {
	const req = new Request(`http://localhost/api/providers/${connectionId}/models`)
	return GET(req, { params: Promise.resolve({ id: connectionId }) })
}

describe("CommandCode catalog — live models reach the dashboard", () => {
	it("returns the vendor catalog with display copy and capability flags", async () => {
		const conn = await seedCommandCode("m1")
		const res = await getModels(conn.id)
		expect(res.status).toBe(200)

		const data = await res.json()
		expect(data.models.map((m: { id: string }) => m.id).sort()).toEqual([
			"claude-sonnet-5-5",
			"deepseek/deepseek-v4.1-flash-fast",
		])

		const sonnet = data.models.find((m: { id: string }) => m.id === "claude-sonnet-5-5")
		expect(sonnet.name).toBe("Claude Sonnet 5.5")
		expect(sonnet.description).toBe("best combo of speed & intelligence")
		expect(sonnet.contextLength).toBe(1000000)
		expect(sonnet.isVL).toBe(true)
		expect(sonnet.isReasoning).toBe(true)

		const flash = data.models.find(
			(m: { id: string }) => m.id === "deepseek/deepseek-v4.1-flash-fast",
		)
		expect(flash.name).toBe("DeepSeek V4.1 Flash Fast (latest)")
		expect(flash.maxOutputTokens).toBe(262144)
		expect(flash.isVL).toBe(false)
		expect(flash.isReasoning).toBe(false)
	})

	it("drops hidden aliases the vendor CLI keeps out of its picker", async () => {
		const conn = await seedCommandCode("m2")
		const data = await (await getModels(conn.id)).json()
		expect(data.models.some((m: { id: string }) => m.id === "stealth/glyph-cluster:free")).toBe(false)
	})

	it("identifies as the CommandCode CLI and never leaks the connection key", async () => {
		const conn = await seedCommandCode("m3")
		const res = await getModels(conn.id)
		const data = await res.json()

		expect(stub.calls).toHaveLength(1)
		expect(stub.calls[0].url).toBe(CATALOG_URL)
		expect(stub.calls[0].headers["x-command-code-version"]).toBeTruthy()
		expect(stub.calls[0].headers["x-cli-surface"]).toBe("cli")

		expect(JSON.stringify(data)).not.toContain(conn.apiKey)
		expect(JSON.stringify(data)).not.toContain("user_live")
	})
})

describe("CommandCode catalog — failure handling", () => {
	it("surfaces the upstream status instead of crashing", async () => {
		stub.mode = "error"
		const conn = await seedCommandCode("e1")
		const res = await getModels(conn.id)
		// The resolver falls back to the static catalog rather than failing the request.
		expect(res.status).toBe(200)
		const data = await res.json()
		expect(data.warning).toMatch(/no live models/i)
		expect(data.models.length).toBeGreaterThan(0)
	})

	it("404s for an unknown connection", async () => {
		const res = await getModels("00000000-0000-0000-0000-000000000000")
		expect(res.status).toBe(404)
	})
})

describe("GET /v1/models — the gateway advertises the live catalog", () => {
	it("replaces the static registry list for the cmc alias", async () => {
		await seedCommandCode("v1")
		const { buildModelsList } = await import("../../apps/web/src/app/api/v1/models/route.js")
		const ids = (await buildModelsList(["llm"])).map((m: { id: string }) => m.id)
		expect(ids).toContain("cmc/claude-sonnet-5-5")
		expect(ids).toContain("cmc/deepseek/deepseek-v4.1-flash-fast")
		expect(ids).not.toContain("cmc/stealth/glyph-cluster:free")
	})
})
