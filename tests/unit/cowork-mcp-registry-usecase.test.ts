import { describe, expect, test } from "bun:test"
import type { RegistryCache } from "../../apps/api/src/application/cowork-mcp/read-mcp-registry.ts"
import {
	fetchRegistry,
	readMcpRegistry,
} from "../../apps/api/src/application/cowork-mcp/read-mcp-registry.ts"
import { REGISTRY_CACHE_TTL_MS } from "../../apps/api/src/domain/cowork-mcp-registry.ts"

/**
 * The registry is a paginated third party, so the two things worth proving are that the walk
 * stops when it should and that the cache never turns a failed refresh into an empty screen.
 * `domain/cowork-mcp-registry.test.ts` covers what an individual entry must look like.
 */

/** A registry entry in the shape the endpoint really returns. */
const server = (name: string, url: string) => ({
	server: { name, description: `${name} server`, remotes: [{ url, type: "http" }] },
	_meta: { "com.anthropic.api/mcp-registry": { slug: name } },
})

const page = (servers: unknown[], nextCursor?: string) =>
	new Response(JSON.stringify({ servers, metadata: nextCursor ? { nextCursor } : {} }), {
		status: 200,
		headers: { "content-type": "application/json" },
	})

/** A fetch that answers from a queue and records the URLs it was asked for. */
const pages = (answers: (() => Response)[]) => {
	const urls: string[] = []
	let index = 0
	const fetchServers = (async (url: string) => {
		urls.push(String(url))
		const answer = answers[index++]
		if (!answer) throw new Error(`unexpected page #${index}`)
		return answer()
	}) as unknown as typeof fetch
	return { fetchServers, urls }
}

const emptyCache = (): RegistryCache => ({ ts: 0, data: null })

describe("walking the registry", () => {
	test("follows the cursor until a page has none", async () => {
		const { fetchServers, urls } = pages([
			() => page([server("a", "https://a.example/mcp")], "cursor-1"),
			() => page([server("b", "https://b.example/mcp")]),
		])
		const out = await fetchRegistry(fetchServers)
		expect(out.map((s) => s.name)).toEqual(["a", "b"])
		expect(urls).toHaveLength(2)
		expect(urls[1]).toContain("cursor=cursor-1")
	})

	test("the first page carries no cursor parameter at all", async () => {
		const { fetchServers, urls } = pages([() => page([])])
		await fetchRegistry(fetchServers)
		expect(urls[0]).not.toContain("cursor=")
	})

	test("a failing page ends the walk and keeps what was collected", async () => {
		const { fetchServers, urls } = pages([
			() => page([server("a", "https://a.example/mcp")], "cursor-1"),
			() => new Response("", { status: 503 }),
			() => page([server("never", "https://never.example/mcp")]),
		])
		const out = await fetchRegistry(fetchServers)
		expect(out.map((s) => s.name)).toEqual(["a"])
		expect(urls).toHaveLength(2)
	})

	test("entries the domain rule rejects are dropped, not listed as blanks", async () => {
		const { fetchServers } = pages([
			() => page([{ name: "no-url" }, server("good", "https://g.example/mcp")]),
		])
		const out = await fetchRegistry(fetchServers)
		expect(out.map((s) => s.name)).toEqual(["good"])
	})

	test("the same url twice appears once", async () => {
		const { fetchServers } = pages([
			() =>
				page([server("first", "https://dup.example/mcp"), server("second", "https://dup.example/mcp")]),
		])
		const out = await fetchRegistry(fetchServers)
		expect(out).toHaveLength(1)
	})

	test("the walk is bounded, so a registry that always answers stops at twenty pages", async () => {
		const answers = Array.from(
			{ length: 30 },
			() => (() => page([server("x", "https://x.example/mcp")], "always-more")) as () => Response,
		)
		const { fetchServers, urls } = pages(answers)
		await fetchRegistry(fetchServers)
		expect(urls).toHaveLength(20)
	})
})

describe("the cache", () => {
	test("a cold cache fetches and reports itself as not cached", async () => {
		const cache = emptyCache()
		const answer = await readMcpRegistry(
			{
				cache,
				fetchServers: pages([() => page([server("a", "https://a.example/mcp")])]).fetchServers,
				now: () => 1_000,
			},
			false,
		)
		expect(answer.status).toBe(200)
		expect(answer.body.cached).toBe(false)
		expect(answer.body.total).toBe(1)
		expect(cache.ts).toBe(1_000)
	})

	test("a fresh cache answers without calling the registry", async () => {
		const cache: RegistryCache = {
			ts: 1_000,
			data: { servers: [], total: 0 },
		}
		const { fetchServers, urls } = pages([])
		const answer = await readMcpRegistry(
			{ cache, fetchServers, now: () => 1_000 + REGISTRY_CACHE_TTL_MS - 1 },
			false,
		)
		expect(answer.body.cached).toBe(true)
		expect(urls).toHaveLength(0)
	})

	test("a cache exactly at the TTL is stale, because the boundary is not fresh", async () => {
		const cache: RegistryCache = { ts: 1_000, data: { servers: [], total: 0 } }
		const { fetchServers, urls } = pages([() => page([])])
		await readMcpRegistry({ cache, fetchServers, now: () => 1_000 + REGISTRY_CACHE_TTL_MS }, false)
		expect(urls).toHaveLength(1)
	})

	test("refresh=1 skips the cache and refetches", async () => {
		const cache: RegistryCache = { ts: 1_000, data: { servers: [], total: 0 } }
		const { fetchServers, urls } = pages([() => page([server("a", "https://a.example/mcp")])])
		const answer = await readMcpRegistry({ cache, fetchServers, now: () => 1_000 }, true)
		expect(urls).toHaveLength(1)
		expect(answer.body.cached).toBe(false)
	})

	test("a failed refresh reports the error and leaves the cached list intact", async () => {
		const cachedData = { servers: [], total: 0 }
		const cache: RegistryCache = { ts: 1_000, data: cachedData }
		const answer = await readMcpRegistry(
			{
				cache,
				fetchServers: (async () => {
					throw new Error("registry unreachable")
				}) as unknown as typeof fetch,
				now: () => 9_999,
			},
			true,
		)
		expect(answer.status).toBe(500)
		expect(answer.body.error).toBe("registry unreachable")
		// The list survives, so the next screen that asks without ?refresh still shows rows.
		expect(cache.data).toBe(cachedData)
		expect(cache.ts).toBe(1_000)
	})

	test("a non-Error throw still yields a readable message", async () => {
		const answer = await readMcpRegistry(
			{
				cache: emptyCache(),
				fetchServers: (async () => {
					throw "string thrown"
				}) as unknown as typeof fetch,
			},
			false,
		)
		expect(answer.status).toBe(500)
		expect(answer.body.error).toBe("Unknown error")
	})
})
