import { describe, expect, it } from "vitest"
import {
	activeFilterOf,
	boundConnectionCount,
	boundCountAcross,
	bulkDeleteIdsOf,
	bulkDeletionRefusal,
	deletionOutcome,
	poolDeletionRefusal,
	poolInputOf,
	poolTestView,
	poolUpdateOf,
	testResultPatch,
	usesRelay,
} from "../../apps/api/src/domain/proxy-pool.ts"

const httpOnly = (url: string) => url.startsWith("http://") || url.startsWith("https://")

const bound = (proxyPoolId: unknown) => ({ providerSpecificData: { proxyPoolId } })

describe("poolInputOf", () => {
	it("describes a well-formed pool", () => {
		expect(
			poolInputOf(
				{
					name: " Home ",
					proxyUrl: " http://1.2.3.4:8080 ",
					noProxy: " localhost ",
					isActive: false,
					strictProxy: true,
					type: "deno",
				},
				httpOnly,
			),
		).toEqual({
			name: "Home",
			proxyUrl: "http://1.2.3.4:8080",
			noProxy: "localhost",
			isActive: false,
			strictProxy: true,
			type: "deno",
		})
	})

	it("activates a pool by default, so a new pool carries traffic", () => {
		const pool = poolInputOf({ name: "a", proxyUrl: "https://x" }, httpOnly)
		expect(pool).toMatchObject({ isActive: true, strictProxy: false, type: "http" })
	})

	it("requires a name", () => {
		expect(poolInputOf({ proxyUrl: "http://x" }, httpOnly)).toEqual({ error: "Name is required" })
	})

	it("requires a URL", () => {
		expect(poolInputOf({ name: "a" }, httpOnly)).toEqual({ error: "Proxy URL is required" })
	})

	it("refuses a scheme the runtime cannot dial, at save time", () => {
		const result = poolInputOf({ name: "a", proxyUrl: "socks5://1.2.3.4:1080" }, httpOnly)
		expect(result).toMatchObject({ error: expect.stringContaining("socks proxies") })
	})

	it("falls back to http for a type it does not know", () => {
		expect(poolInputOf({ name: "a", proxyUrl: "http://x", type: "smtp" }, httpOnly)).toMatchObject({
			type: "http",
		})
	})

	it("only activates on an absent isActive; anything else means not active", () => {
		expect(poolInputOf({ name: "a", proxyUrl: "http://x" }, httpOnly)).toMatchObject({
			isActive: true,
		})
		expect(
			poolInputOf({ name: "a", proxyUrl: "http://x", isActive: "false" }, httpOnly),
		).toMatchObject({ isActive: false })
	})
})

describe("poolUpdateOf", () => {
	it("writes only the keys that were sent", () => {
		expect(poolUpdateOf({ name: " new " }, httpOnly).patch).toEqual({ name: "new" })
	})

	it("lets an empty noProxy through, which clears the list", () => {
		expect(poolUpdateOf({ noProxy: "" }, httpOnly).patch).toEqual({ noProxy: "" })
	})

	it("refuses an empty name rather than storing one", () => {
		expect(poolUpdateOf({ name: "   " }, httpOnly).refusal).toBe("Name is required")
	})

	it("refuses an empty URL", () => {
		expect(poolUpdateOf({ proxyUrl: "" }, httpOnly).refusal).toBe("Proxy URL is required")
	})

	it("checks the scheme on an updated URL too", () => {
		expect(poolUpdateOf({ proxyUrl: "socks4://x" }, httpOnly).refusal).toContain("socks proxies")
	})

	it("updates the booleans from their exact value", () => {
		expect(poolUpdateOf({ isActive: 0, strictProxy: "true" }, httpOnly).patch).toEqual({
			isActive: false,
			strictProxy: false,
		})
	})

	it("answers an empty patch when nothing was sent", () => {
		expect(poolUpdateOf({}, httpOnly).patch).toEqual({})
	})
})

describe("boundConnectionCount", () => {
	it("counts the connections pointing at one pool", () => {
		expect(boundConnectionCount([bound("p1"), bound("p2"), bound("p1")], "p1")).toBe(2)
	})

	it("does not coerce a numeric id into a string one", () => {
		expect(boundConnectionCount([bound(5)], "5")).toBe(0)
	})

	it("ignores connections with no pool at all", () => {
		expect(boundConnectionCount([{}, { providerSpecificData: null }], "p1")).toBe(0)
	})
})

describe("boundCountAcross", () => {
	it("counts connections across the requested pools only", () => {
		expect(boundCountAcross([bound("a"), bound("b"), bound("c")], ["a", "c"])).toBe(2)
	})

	it("answers zero for an empty selection", () => {
		expect(boundCountAcross([bound("a")], [])).toBe(0)
	})
})

describe("deletion refusals", () => {
	it("refuses a pool that is in use", () => {
		expect(poolDeletionRefusal(2)).toEqual({ error: "Proxy pool is currently in use" })
	})

	it("allows a pool nobody uses", () => {
		expect(poolDeletionRefusal(0)).toBeNull()
	})

	it("names the bulk refusal differently from the single one", () => {
		expect(bulkDeletionRefusal(1)).toEqual({ error: "Some proxy pools are currently in use" })
		expect(bulkDeletionRefusal(0)).toBeNull()
	})
})

describe("bulkDeleteIdsOf", () => {
	it("takes every known id for { all: true }", () => {
		expect(bulkDeleteIdsOf({ all: true }, ["a", "b"])).toEqual(["a", "b"])
	})

	it("collapses duplicates", () => {
		expect(bulkDeleteIdsOf({ all: true }, ["a", "a"])).toEqual(["a"])
	})

	it("takes exactly the ids it was given", () => {
		expect(bulkDeleteIdsOf({ ids: ["a", "b"] }, ["a", "b", "c"])).toEqual(["a", "b"])
	})

	it("drops blanks and non-strings instead of stringifying them", () => {
		expect(bulkDeleteIdsOf({ ids: ["a", "", 5, null] }, [])).toEqual(["a"])
	})

	it("answers nothing when neither form was sent", () => {
		expect(bulkDeleteIdsOf({}, ["a"])).toEqual([])
	})

	it("does not treat all: 1 as delete-everything", () => {
		expect(bulkDeleteIdsOf({ all: 1 }, ["a"])).toEqual([])
	})
})

describe("deletionOutcome", () => {
	it("reports what was removed and what was not", () => {
		expect(deletionOutcome(["a", "b", "c"], [{ id: "a" }, { id: "c" }])).toEqual({
			deleted: ["a", "c"],
			deletedCount: 2,
			missing: ["b"],
		})
	})

	it("names every id missing when the store deleted nothing", () => {
		expect(deletionOutcome(["a"], []).missing).toEqual(["a"])
	})
})

describe("activeFilterOf", () => {
	it("filters on the two boolean literals", () => {
		expect(activeFilterOf("true")).toBe(true)
		expect(activeFilterOf("false")).toBe(false)
	})

	it("does not filter on anything else, so a typo widens the listing", () => {
		expect(activeFilterOf(null)).toBeUndefined()
		expect(activeFilterOf("1")).toBeUndefined()
		expect(activeFilterOf("yes")).toBeUndefined()
	})
})

describe("usesRelay", () => {
	it("tests a deployed relay by asking it, not by dialling it as a proxy", () => {
		expect(usesRelay("vercel")).toBe(true)
		expect(usesRelay("cloudflare")).toBe(true)
		expect(usesRelay("deno")).toBe(true)
		expect(usesRelay("netlify")).toBe(true)
	})

	it("dials a plain http pool directly", () => {
		expect(usesRelay("http")).toBe(false)
	})

	it("treats an unknown type as a direct proxy", () => {
		expect(usesRelay("smtp")).toBe(false)
	})
})

describe("testResultPatch", () => {
	it("marks a passing test active and clears the stale error", () => {
		expect(testResultPatch({ ok: true, status: 200 }, "2026-01-01")).toEqual({
			testStatus: "active",
			lastTestedAt: "2026-01-01",
			lastError: null,
			isActive: true,
		})
	})

	it("marks a failing test inactive and records why", () => {
		expect(testResultPatch({ ok: false, status: 407 }, "2026-01-01")).toMatchObject({
			testStatus: "error",
			lastError: "Proxy test failed with status 407",
			isActive: false,
		})
	})

	it("prefers the error the probe reported over the generic one", () => {
		expect(testResultPatch({ ok: false, status: 502, error: "relay said no" }, "t").lastError).toBe(
			"relay said no",
		)
	})
})

describe("poolTestView", () => {
	it("answers zero elapsed for a failure that never started", () => {
		expect(poolTestView({ ok: false, error: "dns" }, "t")).toMatchObject({ elapsedMs: 0 })
	})

	it("answers nulls rather than undefined, so the screen has one shape", () => {
		const view = poolTestView({ ok: true, status: 200, elapsedMs: 12 }, "t")
		expect(view).toEqual({
			ok: true,
			status: 200,
			statusText: null,
			error: null,
			elapsedMs: 12,
			testedAt: "t",
		})
	})
})
