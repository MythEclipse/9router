import { describe, expect, test } from "bun:test"
import type { ProbeFetch } from "../../apps/api/src/application/cowork-mcp/probe-mcp-tools.ts"
import {
	probeCoworkMcpTools,
	probeMcpServer,
} from "../../apps/api/src/application/cowork-mcp/probe-mcp-tools.ts"

/**
 * The domain rules — `requiresAuthStatus`, `parseSseReply`, `readToolList`, `probeErrorText` —
 * are already covered by `cowork-mcp-probe.test.ts`. What was never testable is the sequence
 * built on them, because it lived inline in the route. So the fake fetch records the calls:
 * the assertions that matter are about *order*, and about who is allowed to say "local".
 */

interface Call {
	readonly url: string
	readonly method?: string
	readonly body?: string
	readonly headers?: Record<string, string>
}

const jsonResponse = (
	body: unknown,
	init: { status?: number; headers?: Record<string, string> } = {},
) =>
	new Response(JSON.stringify(body), {
		status: init.status ?? 200,
		headers: { "content-type": "application/json", ...init.headers },
	})

const sseResponse = (body: string) =>
	new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })

/** Records each call and answers from a queue, so the sequence itself is asserted. */
const recorder = (answers: (() => Response)[]): { fetch: ProbeFetch; calls: Call[] } => {
	const calls: Call[] = []
	let index = 0
	return {
		calls,
		fetch: async (url, init) => {
			calls.push({
				url,
				method: init.method,
				body: typeof init.body === "string" ? init.body : undefined,
				headers: init.headers as Record<string, string>,
			})
			const answer = answers[index++]
			if (!answer) throw new Error(`unexpected call #${index}`)
			return answer()
		},
	}
}

const toolList = (names: string[]) => ({
	result: { tools: names.map((name) => ({ name, description: `${name} does things` })) },
})

const okProbe = (names: string[]) =>
	recorder([
		() => jsonResponse({ result: {} }, { headers: { "mcp-session-id": "sess-1" } }),
		() => jsonResponse({}),
		() => jsonResponse({ jsonrpc: "2.0", id: 2, ...toolList(names) }),
	])

describe("the probe sequence", () => {
	test("initializes, notifies, then lists — in that order", async () => {
		const { fetch, calls } = okProbe(["alpha", "beta"])
		const result = await probeMcpServer("http://localhost:3333/mcp", fetch)

		expect(result.tools.map((t) => t.name)).toEqual(["alpha", "beta"])
		expect(calls).toHaveLength(3)
		expect(calls[0].method).toBe("POST")
		expect(String(calls[0].body)).toContain('"initialize"')
		expect(String(calls[1].body)).toContain('"notifications/initialized"')
		expect(String(calls[2].body)).toContain('"tools/list"')
		expect(String(calls[2].body)).toContain('"id":2')
	})

	test("the issued session id is echoed to later calls but never sent empty", async () => {
		const withSession = okProbe(["a"])
		await probeMcpServer("http://localhost/mcp", withSession.fetch)
		expect(withSession.calls[2].headers?.["mcp-session-id"]).toBe("sess-1")

		const withoutSession = recorder([
			() => jsonResponse({ result: {} }),
			() => jsonResponse({}),
			() => jsonResponse({ jsonrpc: "2.0", id: 2, ...toolList(["a"]) }),
		])
		await probeMcpServer("http://localhost/mcp", withoutSession.fetch)
		expect(withoutSession.calls[2].headers?.["mcp-session-id"]).toBeUndefined()
	})

	test("a server that refuses notifications/initialized still yields its tools", async () => {
		const { fetch } = recorder([
			() => jsonResponse({ result: {} }),
			() => new Response("nope", { status: 400 }),
			() => jsonResponse({ jsonrpc: "2.0", id: 2, ...toolList(["still-works"]) }),
		])
		const result = await probeMcpServer("http://localhost/mcp", fetch)
		expect(result.tools.map((t) => t.name)).toEqual(["still-works"])
	})
})

describe("what a bad answer means", () => {
	test("401 on initialize is requiresAuth, not an error", async () => {
		const { fetch } = recorder([() => new Response("", { status: 401 })])
		expect(await probeMcpServer("http://x/mcp", fetch)).toEqual({ requiresAuth: true, tools: [] })
	})

	test("403 on initialize is requiresAuth too", async () => {
		const { fetch } = recorder([() => new Response("", { status: 403 })])
		expect((await probeMcpServer("http://x/mcp", fetch)).requiresAuth).toBe(true)
	})

	test("401 on tools/list is requiresAuth, not an empty tool list", async () => {
		const { fetch } = recorder([
			() => jsonResponse({ result: {} }),
			() => jsonResponse({}),
			() => new Response("", { status: 401 }),
		])
		expect(await probeMcpServer("http://x/mcp", fetch)).toEqual({ requiresAuth: true, tools: [] })
	})

	test("a non-auth failure names the status without reading a body", async () => {
		const { fetch } = recorder([() => new Response("", { status: 500 })])
		expect(await probeMcpServer("http://x/mcp", fetch)).toEqual({ error: "init 500", tools: [] })
	})

	test("an SSE reply is parsed by id, so a notification is not read as the tool list", async () => {
		const sse = [
			'data: {"jsonrpc":"2.0","method":"notifications/message","result":{"tools":[{"name":"decoy"}]}}',
			'data: {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"real"}]}}',
			"",
		].join("\n")
		const { fetch } = recorder([
			() => jsonResponse({ result: {} }),
			() => jsonResponse({}),
			() => sseResponse(sse),
		])
		const result = await probeMcpServer("http://x/mcp", fetch)
		expect(result.tools.map((t) => t.name)).toEqual(["real"])
	})

	test("a JSON body that is not JSON yields no tools rather than throwing", async () => {
		const { fetch } = recorder([
			() => jsonResponse({ result: {} }),
			() => jsonResponse({}),
			() => new Response("not json", { headers: { "content-type": "application/json" } }),
		])
		expect((await probeMcpServer("http://x/mcp", fetch)).tools).toEqual([])
	})
})

describe("who may probe what", () => {
	const options = (overrides: Partial<Parameters<typeof probeCoworkMcpTools>[1]> = {}) => ({
		fetchFor: (async () => jsonResponse({ result: {} })) as ProbeFetch,
		allowPrivateUrl: false,
		assertPublicUrl: () => undefined,
		...overrides,
	})

	test("a missing url is a 400 that names the field", async () => {
		const answer = await probeCoworkMcpTools({}, options())
		expect(answer.status).toBe(400)
		expect(answer.body.error).toBe("url required")
	})

	test("a non-string url is refused, not coerced", async () => {
		const answer = await probeCoworkMcpTools({ url: 42 }, options())
		expect(answer.status).toBe(400)
	})

	test("a remote caller's private url is a 400 saying the URL is not allowed", async () => {
		const answer = await probeCoworkMcpTools(
			{ url: "http://127.0.0.1:3333/mcp" },
			options({
				assertPublicUrl: () => {
					throw new Error("private address")
				},
			}),
		)
		expect(answer.status).toBe(400)
		expect(answer.body.error).toBe("URL not allowed")
	})

	test("a local caller is not held to a public url, because its server is on loopback", async () => {
		let guardRan = false
		const { fetch } = okProbe(["local-tool"])
		const answer = await probeCoworkMcpTools(
			{ url: "http://127.0.0.1:3333/mcp" },
			options({
				allowPrivateUrl: true,
				fetchFor: fetch,
				assertPublicUrl: () => {
					guardRan = true
				},
			}),
		)
		expect(guardRan).toBe(false)
		expect(answer.status).toBe(200)
	})

	test("a remote caller's public url is checked by the guard and then probed", async () => {
		let guardRan = false
		const { fetch } = okProbe(["public-tool"])
		const answer = await probeCoworkMcpTools(
			{ url: "https://example.com/mcp" },
			options({
				fetchFor: fetch,
				assertPublicUrl: () => {
					guardRan = true
				},
			}),
		)
		expect(guardRan).toBe(true)
		expect(answer.status).toBe(200)
	})

	test("a fetch that throws is reported in a 200 body, because the route always answered 200", async () => {
		const answer = await probeCoworkMcpTools(
			{ url: "https://example.com/mcp" },
			options({
				fetchFor: async () => {
					throw new Error("ECONNREFUSED")
				},
			}),
		)
		// The probe reports a failure the operator can read; only a bad *request* is a 4xx.
		// A 500 here would make a wrong URL look like a broken server on this side.
		expect(answer.status).toBe(200)
		expect(answer.body.error).toBe("ECONNREFUSED")
		expect(answer.body.tools).toEqual([])
	})
})
