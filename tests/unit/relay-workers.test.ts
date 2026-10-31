import { describe, expect, it } from "vitest"
import { NETLIFY_RELAY_FUNCTION_CODE } from "../../apps/web/src/lib/network/netlifyRelay.js"
import {
	CLOUDFLARE_WORKER_CODE,
	DENO_RELAY_CODE,
	RELAY_REQUEST_DROP_HEADERS,
	RELAY_RESPONSE_DROP_HEADERS,
	VERCEL_RELAY_CODE,
} from "../../apps/web/src/lib/network/relayWorkers.js"

/**
 * The four relay workers are strings deployed to four platforms, so nothing
 * typechecks them. These cases execute the generated source instead: the
 * `export default` workers are evaluated with a fake `fetch`, and Deno's
 * `Deno.serve` is stubbed to capture the handler it registers.
 */

type FakeFetch = (url: string, init: RequestInit) => Promise<Response>

function loadWebWorker(
	source: string,
	fakeFetch: FakeFetch,
): (request: Request) => Promise<Response> {
	if (source.includes("Deno.serve")) {
		let captured: ((request: Request) => Promise<Response>) | null = null
		const Deno = { serve: (fn: (request: Request) => Promise<Response>) => void (captured = fn) }
		new Function("Deno", "Headers", "Response", "fetch", source)(Deno, Headers, Response, fakeFetch)
		if (!captured) throw new Error("worker never called Deno.serve")
		return captured
	}
	const body = source.replace("export default", "const __relay =")
	const relay = new Function("Headers", "Response", "fetch", `${body}\nreturn __relay`)(
		Headers,
		Response,
		fakeFetch,
	) as { fetch: (request: Request) => Promise<Response> }
	return relay.fetch
}

function loadNetlify(fakeFetch: FakeFetch) {
	const sandbox: { handler?: (event: unknown) => Promise<unknown> } = {}
	new Function("exports", "fetch", "Buffer", NETLIFY_RELAY_FUNCTION_CODE)(sandbox, fakeFetch, Buffer)
	if (!sandbox.handler) throw new Error("netlify bundle registered no handler")
	return sandbox.handler as (event: unknown) => Promise<{
		statusCode: number
		headers: Record<string, string>
		body: string
	}>
}

const WEB_WORKERS = [
	["vercel", VERCEL_RELAY_CODE],
	["cloudflare", CLOUDFLARE_WORKER_CODE],
	["deno", DENO_RELAY_CODE],
] as const

const okFetch: FakeFetch = async () =>
	new Response("hello", {
		status: 200,
		headers: {
			"content-type": "text/event-stream",
			// What an upstream sends when it compressed the body. `fetch` has
			// already decoded it, so forwarding these truncates the reply.
			"content-encoding": "gzip",
			"content-length": "9999",
		},
	})

describe.each(WEB_WORKERS)("%s relay worker", (_name, source) => {
	it("refuses a non-https target instead of proxying it", async () => {
		const handler = loadWebWorker(source, okFetch)
		const res = await handler(
			new Request("https://relay.test/", {
				headers: { "x-relay-target": "http://169.254.169.254" },
			}),
		)

		expect(res.status).toBe(400)
		expect(await res.text()).toContain("https origin")
	})

	it("refuses a request with no target at all", async () => {
		const handler = loadWebWorker(source, okFetch)
		const res = await handler(new Request("https://relay.test/"))

		expect(res.status).toBe(400)
	})

	it("drops the upstream's encoding headers, which no longer describe the body", async () => {
		const handler = loadWebWorker(source, okFetch)
		const res = await handler(
			new Request("https://relay.test/", {
				headers: { "x-relay-target": "https://api.example.com", "x-relay-path": "/v1/chat" },
			}),
		)

		expect(res.status).toBe(200)
		expect(res.headers.get("content-encoding")).toBeNull()
		expect(res.headers.get("content-length")).toBeNull()
		expect(res.headers.get("content-type")).toContain("text/event-stream")
		expect(await res.text()).toBe("hello")
	})

	it("does not forward its own control headers upstream", async () => {
		let seen: RequestInit | null = null
		const recording: FakeFetch = async (_url, init) => {
			seen = init
			return new Response("ok", { status: 200 })
		}
		const handler = loadWebWorker(source, recording)
		await handler(
			new Request("https://relay.test/", {
				method: "POST",
				body: "payload",
				headers: {
					"x-relay-target": "https://api.example.com",
					"x-relay-path": "/v1/chat",
					authorization: "Bearer test",
				},
			}),
		)

		const forwarded = new Headers((seen as RequestInit | null)?.headers)
		expect(forwarded.get("x-relay-target")).toBeNull()
		expect(forwarded.get("x-relay-path")).toBeNull()
		expect(forwarded.get("authorization")).toBe("Bearer test")
	})

	it("carries the shared drop lists rather than its own copy", () => {
		expect(source).toContain(JSON.stringify(RELAY_REQUEST_DROP_HEADERS))
		expect(source).toContain(JSON.stringify(RELAY_RESPONSE_DROP_HEADERS))
	})
})

describe("netlify relay worker", () => {
	it("refuses a non-https target", async () => {
		const handler = loadNetlify(okFetch)
		const res = await handler({ headers: { "x-relay-target": "http://169.254.169.254" } })

		expect(res.statusCode).toBe(400)
		expect(res.body).toContain("https origin")
	})

	it("drops the upstream's encoding headers", async () => {
		const handler = loadNetlify(okFetch)
		const res = await handler({
			headers: { "x-relay-target": "https://api.example.com", "x-relay-path": "/v1/chat" },
			httpMethod: "GET",
		})

		expect(res.statusCode).toBe(200)
		expect(res.headers["content-encoding"]).toBeUndefined()
		expect(res.headers["content-length"]).toBeUndefined()
		expect(res.headers["content-type"]).toContain("text/event-stream")
	})

	it("does not forward its own control headers upstream", async () => {
		let seen: RequestInit | null = null
		const handler = loadNetlify(async (_url, init) => {
			seen = init
			return new Response("ok", { status: 200 })
		})
		await handler({
			headers: {
				"x-relay-target": "https://api.example.com",
				"x-relay-path": "/v1/chat",
				authorization: "Bearer test",
			},
			httpMethod: "GET",
		})

		const forwarded = new Headers((seen as RequestInit | null)?.headers)
		expect(forwarded.get("x-relay-target")).toBeNull()
		expect(forwarded.get("authorization")).toBe("Bearer test")
	})
})
