/**
 * The suggested-model proxy prefers a stored catalogue over an empty list.
 *
 * A background sync keeps the last known free models in sqlite. When the
 * provider's own endpoint is slow, blocked, or answering with an empty list,
 * the route must serve that stored copy flagged stale instead of the blank
 * answer that used to make the suggested row disappear on some installs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const SYNCED = {
	data: [
		{ id: "big-pickle", name: "big-pickle" },
		{ id: "muse-spark-1.3-contributor-free", name: "muse-spark-1.3-contributor-free" },
	],
	syncedAt: 1790000000000,
	url: "https://opencode.ai/inference/v1/models",
}

const syncedGet = vi.fn(async () => null)
const undiciFetch = vi.fn()

vi.mock("@/shared/services/freeCatalogSync.js", () => ({
	getSyncedFreeCatalog: (...a) => syncedGet(...a),
	syncOneFreeCatalog: vi.fn(async () => 1),
	startFreeCatalogSync: vi.fn(),
}))

vi.mock("undici", () => ({
	fetch: undiciFetch,
}))

const ROUTE_URL =
	"/api/providers/suggested-models?url=" +
	encodeURIComponent("https://opencode.ai/inference/v1/models") +
	"&type=opencode-free"

/**
 * The route's dependencies, over the mocks above.
 *
 * The route delegates to `suggestModels` now, so building the whole graph would
 * open a second SQLite handle — which `createDb` refuses under Vitest. The
 * use-case is assembled here over the real filter table and the injected
 * synced-copy and fetch stubs, so what is under test (which answer wins when
 * upstream fails) is still the real code.
 */
async function useCases() {
	const { makeSuggestModels } = await import(
		"../../apps/api/src/application/providers/suggest-models.ts"
	)
	const host = await import("@/lib/providerConnectionHost")
	const suggestModels = makeSuggestModels({
		catalogue: host.suggestedCatalogue,
		findSyncable: host.findSyncableCatalogue,
		readSynced: async (entryId) => {
			const synced = await syncedGet(entryId)
			if (!synced) return null
			return { data: synced.data, syncedAt: synced.syncedAt }
		},
		refreshSynced: () => {},
		fetchCatalogue: async (url, type) => {
			const res = await undiciFetch(url, type === "opencode-free" ? {} : {})
			return res.json()
		},
		armSyncer: () => {},
		timeoutMs: 12_000,
	})
	return { suggestModels }
}

function request() {
	return new Request("http://localhost" + ROUTE_URL)
}

/** Point the route at the stubbed graph before importing it. */
async function route() {
	const graph = await useCases()
	vi.doMock("@/lib/useCases", () => ({ getUseCases: () => graph }))
	return import("../../apps/web/src/app/api/providers/suggested-models/route.js")
}

describe("suggested-models route durability", () => {
	beforeEach(() => {
		syncedGet.mockClear()
		undiciFetch.mockClear()
		undiciFetch.mockRejectedValue(new TypeError("fetch failed"))
	})

	afterEach(() => {
		undiciFetch.mockReset()
	})

	it("serves the live list untouched when upstream answers", async () => {
		syncedGet.mockResolvedValue(SYNCED)
		undiciFetch.mockResolvedValue(
			new Response(
				JSON.stringify({
					data: [{ id: "fresh-model-free", name: "fresh-model-free" }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		)
		const { GET } = await route()
		const res = await GET(request())
		const body = await res.json()
		expect(body.stale).toBeFalsy()
		expect(body.error ?? null).toBeNull()
		expect(body.data.map((m) => m.id)).toEqual(["fresh-model-free"])
	})

	it("serves the synced copy flagged stale when upstream is unreachable", async () => {
		syncedGet.mockResolvedValue(SYNCED)
		undiciFetch.mockRejectedValue(new TypeError("fetch failed"))
		const { GET } = await route()
		const res = await GET(request())
		const body = await res.json()
		expect(body.stale).toBe(true)
		expect(body.error).toMatch(/last synced models/)
		expect(body.data).toEqual(SYNCED.data)
		expect(body.syncedAt).toBe(SYNCED.syncedAt)
	})

	it("falls back to built-in models only when nothing was ever synced", async () => {
		syncedGet.mockResolvedValue(null)
		undiciFetch.mockRejectedValue(new TypeError("fetch failed"))
		const { GET } = await route()
		const res = await GET(request())
		const body = await res.json()
		expect(body.stale).toBeFalsy()
		expect(body.error).toBeTruthy()
		expect(body.data.length).toBeGreaterThan(0)
	})

	it("prefers the synced copy over an empty upstream answer", async () => {
		syncedGet.mockResolvedValue(SYNCED)
		undiciFetch.mockResolvedValue(
			new Response(JSON.stringify({ data: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		)
		const { GET } = await route()
		const res = await GET(request())
		const body = await res.json()
		expect(body.stale).toBe(true)
		expect(body.data).toEqual(SYNCED.data)
	})

	it("rejects an unknown filter without touching the network", async () => {
		const { GET } = await route()
		const res = await GET(
			new Request("http://localhost/api/providers/suggested-models?url=x&type=nope"),
		)
		expect(res.status).toBe(400)
	})
})
