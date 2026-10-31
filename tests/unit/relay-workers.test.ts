import { Readable, Writable } from "node:stream"
import zlib, { gzipSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import { NETLIFY_RELAY_FUNCTION_CODE } from "../../apps/web/src/lib/network/netlifyRelay.js"
import {
	CLOUDFLARE_WORKER_CODE,
	DENO_RELAY_CODE,
	RELAY_ENTRYPOINT_FILE,
	RELAY_REQUEST_DROP_HEADERS,
	RELAY_RESPONSE_DROP_HEADERS,
	RELAY_WREQ_CIPHER_LIST,
	RELAY_WREQ_DEPENDENCIES,
	RELAY_WREQ_INCLUDE_FILES,
	VERCEL_RELAY_CODE,
	VERCEL_WREQ_RELAY_CODE,
	vercelRelayFiles,
} from "../../apps/web/src/lib/network/relayWorkers.js"

/**
 * The four relay workers are strings deployed to four platforms, so nothing
 * typechecks them. These cases execute the generated source instead, with the
 * transport each platform actually uses: Vercel's worker speaks `node:https`,
 * the others `fetch`, and Deno's `Deno.serve` is stubbed to capture the handler
 * it registers.
 */

interface UpstreamReply {
	status: number
	headers: Record<string, string>
	body: string
}

interface UpstreamCall {
	url: string
	method: string
	headers: Headers
	body: string
	/** Which hop carried it. Assertions read this, not a counter captured too early. */
	transport: "fetch" | "https" | "wreq"
	/** The emulation the wreq hop asked for, when that hop was used. */
	emulation?: unknown
}

interface Sandbox {
	handler: (request: Request) => Promise<Response>
	calls: UpstreamCall[]
}

const STREAM_REPLY: UpstreamReply = {
	status: 200,
	headers: {
		"content-type": "text/event-stream",
		// What an upstream sends when it compressed the body. The transport has
		// already decoded it, so forwarding these truncates the reply.
		"content-encoding": "gzip",
		"content-length": "9999",
	},
	body: "hello",
}

async function readBody(body: unknown): Promise<string> {
	if (!body) return ""
	if (typeof body === "string") return body
	if (body instanceof ReadableStream) {
		const chunks: Uint8Array[] = []
		const reader = body.getReader()
		for (;;) {
			const { value, done } = await reader.read()
			if (done) break
			chunks.push(value)
		}
		return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString()
	}
	return ""
}

function loadWebWorker(source: string, reply: UpstreamReply = STREAM_REPLY): Sandbox {
	const calls: UpstreamCall[] = []
	const sandbox: Sandbox = { handler: async () => new Response("unset"), calls }

	const fakeFetch = async (url: string, init: RequestInit) => {
		calls.push({
			url,
			method: String(init.method),
			headers: new Headers(init.headers),
			body: await readBody(init.body),
			transport: "fetch",
		})
		return new Response(reply.body, { status: reply.status, headers: reply.headers })
	}

	const fakeHttps = {
		request: (
			options: {
				hostname: string
				path: string
				method: string
				headers: Record<string, string>
			},
			onResponse: (incoming: unknown) => void,
		) => {
			const chunks: Buffer[] = []
			calls.push({
				url: `https://${options.hostname}${options.path}`,
				method: options.method,
				headers: new Headers(options.headers),
				body: "",
				transport: "https",
			})
			const call = calls[calls.length - 1]
			return new Writable({
				write: (chunk, _encoding, done) => {
					chunks.push(Buffer.from(chunk))
					call.body = Buffer.concat(chunks).toString()
					done()
				},
				final: (done) => {
					// A raw socket delivers the bytes as they went over the wire, so a
					// gzip reply is genuinely gzipped here - the worker has to decode it.
					const payload =
						reply.headers["content-encoding"] === "gzip" ? gzipSync(reply.body) : Buffer.from(reply.body)
					const incoming = Object.assign(Readable.from([payload]), {
						statusCode: reply.status,
						headers: reply.headers,
					})
					onResponse(incoming)
					done()
				},
			})
		},
	}

	/**
	 * The wreq module as the worker sees it.
	 *
	 * Shaped from the real one: `fetch(url, { emulation })` answers an object with
	 * `headers.forEach` and a web-stream `body`, which is what the worker consumes.
	 */
	const fakeWreq = {
		fetch: async (
			url: string,
			init: {
				method: string
				headers: Record<string, string>
				body?: string
				emulation?: unknown
			},
		) => {
			calls.push({
				url,
				method: init.method,
				headers: new Headers(init.headers),
				body: typeof init.body === "string" ? init.body : "",
				transport: "wreq",
				emulation: init.emulation,
			})
			return {
				status: reply.status,
				headers: new Headers(reply.headers),
				body: new Response(reply.body).body,
			}
		},
	}

	// The generated module carries top-level imports; the sandbox supplies those
	// bindings as arguments instead. The wreq worker loads its binding with a
	// dynamic import, which a generated function cannot resolve, so that call is
	// pointed at the fake module below.
	const withoutImports = source
		.replace(/^import .*$/gm, "")
		.replace('await import("wreq-js")', "wreqModule")

	if (source.includes("Deno.serve")) {
		let captured: ((request: Request) => Promise<Response>) | null = null
		const Deno = { serve: (fn: (request: Request) => Promise<Response>) => void (captured = fn) }
		new Function("Deno", "Headers", "Response", "fetch", withoutImports)(
			Deno,
			Headers,
			Response,
			fakeFetch,
		)
		if (!captured) throw new Error("worker never called Deno.serve")
		sandbox.handler = captured
		return sandbox
	}

	const body = withoutImports.replace("export default", "const __relay =")
	const relay = new Function(
		"Headers",
		"Response",
		"fetch",
		"https",
		"Readable",
		"zlib",
		"wreqModule",
		`${body}\nreturn __relay`,
	)(Headers, Response, fakeFetch, fakeHttps, Readable, zlib, fakeWreq) as {
		fetch: (request: Request) => Promise<Response>
	}

	sandbox.handler = relay.fetch
	return sandbox
}

function loadNetlify(fakeFetch: (url: string, init: RequestInit) => Promise<Response>) {
	const sandbox: { handler?: (event: unknown) => Promise<unknown> } = {}
	new Function("exports", "fetch", "Buffer", NETLIFY_RELAY_FUNCTION_CODE)(sandbox, fakeFetch, Buffer)
	if (!sandbox.handler) throw new Error("netlify bundle registered no handler")
	return sandbox.handler as (event: unknown) => Promise<{
		statusCode: number
		headers: Record<string, string>
		body: string
	}>
}

const okFetch = async () => new Response("hello", { status: 200, headers: STREAM_REPLY.headers })

const WEB_WORKERS = [
	["vercel", VERCEL_RELAY_CODE],
	["vercel-wreq", VERCEL_WREQ_RELAY_CODE],
	["cloudflare", CLOUDFLARE_WORKER_CODE],
	["deno", DENO_RELAY_CODE],
] as const

describe.each(WEB_WORKERS)("%s relay worker", (_name, source) => {
	it("refuses a non-https target instead of proxying it", async () => {
		const { handler } = loadWebWorker(source)
		const res = await handler(
			new Request("https://relay.test/", {
				headers: { "x-relay-target": "http://169.254.169.254" },
			}),
		)

		expect(res.status).toBe(400)
		expect(await res.text()).toContain("https origin")
	})

	it("refuses a request with no target at all", async () => {
		const { handler } = loadWebWorker(source)
		const res = await handler(new Request("https://relay.test/"))

		expect(res.status).toBe(400)
	})

	it("drops the upstream's encoding headers, which no longer describe the body", async () => {
		const { handler } = loadWebWorker(source)
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

	it("joins the target origin with the relayed path", async () => {
		const { handler, calls } = loadWebWorker(source)
		await handler(
			new Request("https://relay.test/", {
				headers: { "x-relay-target": "https://api.example.com/", "x-relay-path": "/v1/chat" },
			}),
		)

		expect(calls).toHaveLength(1)
		expect(calls[0].url).toBe("https://api.example.com/v1/chat")
	})

	it("does not forward its own control headers upstream", async () => {
		const { handler, calls } = loadWebWorker(source)
		await handler(
			new Request("https://relay.test/", {
				method: "POST",
				body: "payload",
				headers: {
					"x-relay-target": "https://api.example.com",
					"x-relay-path": "/v1/chat",
					authorization: "Bearer test",
					// Platform traces: they announce the serverless host and the
					// operator's real IP to a provider that rate-limits on them.
					"x-vercel-id": "fra1::abc123",
					"x-forwarded-for": "203.0.113.9",
					// The two that hid behind different names: RFC 7239's sibling of
					// x-forwarded-for, and Vercel's invocation id.
					forwarded: "for=203.0.113.9;host=relay.vercel.app",
					"x-invocation-id": "fra1::abc123",
				},
			}),
		)

		const forwarded = calls[0].headers
		expect(forwarded.get("x-relay-target")).toBeNull()
		expect(forwarded.get("x-relay-path")).toBeNull()
		expect(forwarded.get("x-vercel-id")).toBeNull()
		expect(forwarded.get("x-forwarded-for")).toBeNull()
		expect(forwarded.get("forwarded")).toBeNull()
		expect(forwarded.get("x-invocation-id")).toBeNull()
		expect(forwarded.get("authorization")).toBe("Bearer test")
	})

	it("carries the request body upstream intact", async () => {
		const { handler, calls } = loadWebWorker(source)
		await handler(
			new Request("https://relay.test/", {
				method: "POST",
				body: JSON.stringify({ hello: "relay" }),
				headers: { "x-relay-target": "https://api.example.com", "x-relay-path": "/v1/chat" },
			}),
		)

		expect(calls[0].method).toBe("POST")
		expect(JSON.parse(calls[0].body)).toEqual({ hello: "relay" })
	})

	it("carries the shared drop lists rather than its own copy", () => {
		expect(source).toContain(JSON.stringify(RELAY_REQUEST_DROP_HEADERS))
		expect(source).toContain(JSON.stringify(RELAY_RESPONSE_DROP_HEADERS))
	})
})

describe("vercel relay worker", () => {
	it("hops over node:https, because fetch is stamped with x-vercel-id", async () => {
		// Live measurement: `fetch` reached httpbin, postman-echo and httpbingo
		// carrying `x-vercel-id` plus an `x-forwarded-for` chain; the same hop over
		// node:https arrived with none. If this worker ever goes back to `fetch`,
		// the platform trace returns and the strip above cannot prevent it.
		const { handler, calls } = loadWebWorker(VERCEL_RELAY_CODE)
		await handler(
			new Request("https://relay.test/", {
				headers: { "x-relay-target": "https://api.example.com", "x-relay-path": "/v1/chat" },
			}),
		)

		expect(calls).toHaveLength(1)
		expect(calls[0].transport).toBe("https")
		expect(VERCEL_RELAY_CODE).toContain("node:https")
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
				"x-nf-request-id": "01HXYZ",
			},
			httpMethod: "GET",
		})

		const forwarded = new Headers((seen as RequestInit | null)?.headers)
		expect(forwarded.get("x-relay-target")).toBeNull()
		expect(forwarded.get("x-nf-request-id")).toBeNull()
		expect(forwarded.get("authorization")).toBe("Bearer test")
	})
})

describe("relay entrypoint", () => {
	it("is a filename Vercel can infer a runtime from", () => {
		// Live failure without the extension: the file is uploaded and served as a
		// static asset, so `GET /` answers 200 with the worker's own source and
		// POST answers 405 - every relayed request silently becomes a source dump.
		expect(RELAY_ENTRYPOINT_FILE).toMatch(/\.(js|mjs|cjs|ts|mts)$/)
	})

	it("stays inside the api directory", () => {
		expect(RELAY_ENTRYPOINT_FILE.startsWith("api/")).toBe(true)
	})
})

describe("vercel wreq relay worker", () => {
	it("asks for the emulated cipher list, in the order that makes the fingerprint", async () => {
		const { handler, calls } = loadWebWorker(VERCEL_WREQ_RELAY_CODE)
		await handler(
			new Request("https://relay.test/", {
				headers: { "x-relay-target": "https://api.example.com", "x-relay-path": "/v1/chat" },
			}),
		)

		expect(calls[0].transport).toBe("wreq")
		expect(calls[0].emulation).toEqual({
			tlsOptions: { cipherList: RELAY_WREQ_CIPHER_LIST.join(":") },
		})
	})

	it("buffers the request body, which the emulated client cannot stream", async () => {
		// The reply is the stream that must not be buffered; the request is a small
		// JSON body, and wreq takes it as a value rather than a stream.
		const { handler, calls } = loadWebWorker(VERCEL_WREQ_RELAY_CODE)
		const res = await handler(
			new Request("https://relay.test/", {
				method: "POST",
				body: JSON.stringify({ messages: [] }),
				headers: { "x-relay-target": "https://api.example.com", "x-relay-path": "/v1/chat" },
			}),
		)

		expect(JSON.parse(calls[0].body)).toEqual({ messages: [] })
		expect(await res.text()).toBe("hello")
	})

	it("fails loudly when the binding is missing instead of falling back", async () => {
		// A silent fallback would report success while presenting the platform's
		// fingerprint, which is the one thing this hop exists to avoid.
		const source = VERCEL_WREQ_RELAY_CODE.replace(
			'await import("wreq-js")',
			'await Promise.reject(new Error("Failed to load native module"))',
		)
		const { handler } = loadWebWorker(source)
		const res = await handler(
			new Request("https://relay.test/", {
				headers: { "x-relay-target": "https://api.example.com", "x-relay-path": "/v1/chat" },
			}),
		)

		expect(res.status).toBe(502)
		expect(await res.text()).toContain("native module")
	})
})

describe("vercelRelayFiles", () => {
	const byName = (transport: "https" | "wreq") =>
		Object.fromEntries(vercelRelayFiles("relay-x", transport).map((f) => [f.file, f.data]))

	it("ships the plain worker and no dependency for the https hop", () => {
		const files = byName("https")

		expect(files[RELAY_ENTRYPOINT_FILE]).toBe(VERCEL_RELAY_CODE)
		expect(JSON.parse(files["package.json"])).toEqual({ name: "relay-x", version: "1.0.0" })
		expect(JSON.parse(files["vercel.json"]).functions).toBeUndefined()
	})

	it("ships the worker, the binding and the include glob together for the wreq hop", () => {
		// These three only work as a set: the worker imports the loader, the loader
		// needs the binding installed, and the bundler drops the binding unless the
		// glob puts it back.
		const files = byName("wreq")
		const manifest = JSON.parse(files["package.json"])
		const config = JSON.parse(files["vercel.json"])

		expect(files[RELAY_ENTRYPOINT_FILE]).toBe(VERCEL_WREQ_RELAY_CODE)
		expect(manifest.dependencies).toEqual(RELAY_WREQ_DEPENDENCIES)
		expect(manifest.type).toBe("module")
		expect(config.functions[RELAY_ENTRYPOINT_FILE].includeFiles).toBe(RELAY_WREQ_INCLUDE_FILES)
	})

	it("keeps both hops on Bun, which the binding is built for", () => {
		expect(JSON.parse(byName("https")["vercel.json"]).bunVersion).toBe("1.x")
		expect(JSON.parse(byName("wreq")["vercel.json"]).bunVersion).toBe("1.x")
	})

	it("rewrites every path to the entrypoint it deployed", () => {
		for (const transport of ["https", "wreq"] as const) {
			const config = JSON.parse(byName(transport)["vercel.json"])
			expect(config.rewrites).toEqual([{ source: "/(.*)", destination: "/api/relay" }])
		}
	})
})
