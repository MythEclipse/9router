import { describe, expect, it, vi } from "vitest"
import {
	bulkDeleteProxyPools,
	createProxyPool,
	deleteProxyPool,
	listProxyPools,
	PoolInUseError,
	type ProxyPoolDeps,
	readProxyPool,
	testProxyPool,
	updateProxyPool,
} from "../../apps/api/src/application/proxy-pools/manage-proxy-pools.ts"

const POOL = { id: "p1", type: "http", proxyUrl: "http://1.2.3.4:8080", name: "Home" }

const boundTo = (proxyPoolId: unknown) => ({ providerSpecificData: { proxyPoolId } })

function deps(overrides: Partial<ProxyPoolDeps> = {}): ProxyPoolDeps {
	return {
		exists: vi.fn(async () => true),
		list: vi.fn(async () => [POOL]),
		findById: vi.fn(async () => POOL),
		create: vi.fn(async () => POOL),
		update: vi.fn(async () => POOL),
		remove: vi.fn(async () => undefined),
		removeMany: vi.fn(async (ids: string[]) => ids.map((id) => ({ ...POOL, id }))),
		boundConnections: vi.fn(async () => []),
		supportedScheme: vi.fn(() => true),
		probe: vi.fn(async () => ({ ok: true, status: 200, elapsedMs: 5 })),
		...overrides,
	}
}

const params = (query = "") => new URLSearchParams(query)

describe("listProxyPools", () => {
	it("filters on isActive only when the query says so", async () => {
		const d = deps()
		await listProxyPools(params("isActive=false"), d)
		expect(d.list).toHaveBeenCalledWith({ isActive: false })
	})

	it("does not filter on a typo", async () => {
		const d = deps()
		await listProxyPools(params("isActive=1"), d)
		expect(d.list).toHaveBeenCalledWith({})
	})

	it("does not count usage unless asked", async () => {
		const d = deps()
		await listProxyPools(params(), d)
		expect(d.boundConnections).not.toHaveBeenCalled()
	})

	it("counts the connections bound to each pool when asked", async () => {
		const d = deps({ boundConnections: vi.fn(async () => [boundTo("p1"), boundTo("p1")]) })
		const answer = await listProxyPools(params("includeUsage=true"), d)
		expect(answer.proxyPools).toEqual([{ ...POOL, boundConnectionCount: 2 }])
	})
})

describe("createProxyPool", () => {
	it("creates a pool the domain accepted", async () => {
		const d = deps()
		await createProxyPool({ name: "Home", proxyUrl: "http://x" }, d)
		expect(d.create).toHaveBeenCalledWith(
			expect.objectContaining({ name: "Home", proxyUrl: "http://x", isActive: true }),
		)
	})

	it("refuses a name-less pool without touching the store", async () => {
		const d = deps()
		await expect(createProxyPool({ proxyUrl: "http://x" }, d)).rejects.toThrow("Name is required")
		expect(d.create).not.toHaveBeenCalled()
	})

	it("refuses a socks URL at save time", async () => {
		const d = deps({ supportedScheme: vi.fn(() => false) })
		await expect(createProxyPool({ name: "a", proxyUrl: "socks5://x" }, d)).rejects.toThrow(
			"socks proxies",
		)
	})
})

describe("readProxyPool", () => {
	it("answers the pool", async () => {
		expect(await readProxyPool("p1", deps())).toEqual({ proxyPool: POOL })
	})

	it("answers not-found for a missing pool", async () => {
		await expect(
			readProxyPool("nope", deps({ findById: vi.fn(async () => null) })),
		).rejects.toMatchObject({ code: "NOT_FOUND" })
	})
})

describe("updateProxyPool", () => {
	it("writes only the fields that were sent", async () => {
		const d = deps()
		await updateProxyPool("p1", { name: "Renamed" }, d)
		expect(d.update).toHaveBeenCalledWith("p1", { name: "Renamed" })
	})

	it("checks existence before validating the body", async () => {
		const d = deps({ findById: vi.fn(async () => null) })
		await expect(updateProxyPool("gone", { name: "" }, d)).rejects.toMatchObject({
			code: "NOT_FOUND",
		})
	})

	it("refuses an empty name", async () => {
		const d = deps()
		await expect(updateProxyPool("p1", { name: "  " }, d)).rejects.toThrow("Name is required")
	})
})

describe("deleteProxyPool", () => {
	it("removes a pool nobody uses", async () => {
		const d = deps()
		expect(await deleteProxyPool("p1", d)).toEqual({ success: true })
		expect(d.remove).toHaveBeenCalledWith("p1")
	})

	it("refuses a pool a connection is bound to, and does not remove it", async () => {
		const d = deps({ boundConnections: vi.fn(async () => [boundTo("p1")]) })
		await expect(deleteProxyPool("p1", d)).rejects.toBeInstanceOf(PoolInUseError)
		expect(d.remove).not.toHaveBeenCalled()
	})

	it("carries the count in the refusal, so the screen can name what is in the way", async () => {
		const d = deps({ boundConnections: vi.fn(async () => [boundTo("p1"), boundTo("p1")]) })
		await expect(deleteProxyPool("p1", d)).rejects.toMatchObject({ boundConnectionCount: 1 })
	})
})

describe("bulkDeleteProxyPools", () => {
	it("resolves { all: true } on the server", async () => {
		const d = deps({
			list: vi.fn(async () => [POOL, { ...POOL, id: "p2" }]),
			removeMany: vi.fn(async (ids: string[]) => ids.map((id) => ({ ...POOL, id }))),
		})
		const answer = await bulkDeleteProxyPools({ all: true }, d)
		expect(answer).toEqual({ deleted: ["p1", "p2"], deletedCount: 2, missing: [] })
	})

	it("answers nothing for an empty selection without querying connections", async () => {
		const d = deps()
		expect(await bulkDeleteProxyPools({}, d)).toEqual({
			deleted: [],
			deletedCount: 0,
			missing: [],
		})
		expect(d.boundConnections).not.toHaveBeenCalled()
	})

	it("deletes nothing when any selected pool is bound", async () => {
		const d = deps({ boundConnections: vi.fn(async () => [boundTo("p2")]) })
		await expect(bulkDeleteProxyPools({ ids: ["p1", "p2"] }, d)).rejects.toBeInstanceOf(
			PoolInUseError,
		)
		expect(d.removeMany).not.toHaveBeenCalled()
	})

	it("names the ids the store did not actually remove", async () => {
		const d = deps({ removeMany: vi.fn(async () => [POOL]) })
		expect(await bulkDeleteProxyPools({ ids: ["p1", "p2"] }, d)).toMatchObject({
			missing: ["p2"],
			deletedCount: 1,
		})
	})
})

describe("testProxyPool", () => {
	const now = () => "2026-01-01T00:00:00.000Z"

	it("records a passing test, and re-activates the pool", async () => {
		const d = deps()
		await testProxyPool("p1", d, now)
		expect(d.update).toHaveBeenCalledWith("p1", {
			testStatus: "active",
			lastTestedAt: "2026-01-01T00:00:00.000Z",
			lastError: null,
			isActive: true,
		})
	})

	it("records a failing test, and deactivates the pool", async () => {
		const d = deps({
			probe: vi.fn(async () => ({ ok: false, status: 407, error: "proxy refused" })),
		})
		await testProxyPool("p1", d, now)
		expect(d.update).toHaveBeenCalledWith(
			"p1",
			expect.objectContaining({ testStatus: "error", lastError: "proxy refused", isActive: false }),
		)
	})

	it("answers what the screen renders", async () => {
		const answer = await testProxyPool("p1", deps(), now)
		expect(answer).toMatchObject({ ok: true, status: 200, elapsedMs: 5, testedAt: now() })
	})

	it("does not probe or record for a missing pool", async () => {
		const d = deps({ findById: vi.fn(async () => null) })
		await expect(testProxyPool("gone", d, now)).rejects.toMatchObject({ code: "NOT_FOUND" })
		expect(d.probe).not.toHaveBeenCalled()
	})
})
