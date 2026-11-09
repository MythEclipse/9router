import type { ProxyOptions } from "../types.ts"
import { proxyAwareFetch } from "../utils/proxyFetch.ts"
import type { CursorHttp2Response, CursorWireBody } from "./cursor.ts"

// Vercel's edge runtime injects `EdgeRuntime` as a global; it is absent under
// Node. Declared here (rather than assumed) so `typeof EdgeRuntime` type-checks.
declare const EdgeRuntime: string | undefined

// Detect cloud environment
const isCloudEnv = () => {
	if (typeof caches !== "undefined" && typeof caches === "object") return true
	if (typeof EdgeRuntime !== "undefined") return true
	return false
}

// Lazy import http2 (only in Node.js environment)
type Http2Module = typeof import("http2")
export let http2: Http2Module | null = null
if (!isCloudEnv()) {
	try {
		http2 = await import("node:http2")
	} catch {
		// http2 not available
	}
}

// The AgentService h2 path bypasses proxyAwareFetch (Node http2 duplex, no
// dispatcher), so the strict-proxy guarantee that proxyFetch enforces for
// regular fetch never applies here. Until h2 proxying lands (see #3276),
// honor just the policy side: when a proxy is intended AND strict AND cannot
// be resolved for this request, fail closed instead of silently opening a
// direct socket that exposes the host's real IP — the exact leak strict mode
// exists to prevent (#4333). Non-strict callers keep today's direct behavior.
export const proxyIntentFailed = (proxyOptions) => {
	if (proxyOptions?.strictProxy !== true) return false
	const proxyIntended = Boolean(
		proxyOptions?.proxyPoolId ||
			proxyOptions?.enabled === true ||
			proxyOptions?.connectionProxyEnabled === true ||
			(proxyOptions?.url || proxyOptions?.connectionProxyUrl || "").trim().length > 0,
	)
	if (!proxyIntended) return false
	// A vercel/cloudflare-style relay rides on plain fetch, not this h2 path.
	if (proxyOptions?.vercelRelayUrl) return false
	// Proxy intended and strict: the h2 transport below cannot carry it.
	return true
}

export async function makeFetchRequest(
	url: string,
	headers: Record<string, string>,
	body: CursorWireBody,
	signal?: AbortSignal,
	proxyOptions: ProxyOptions | null = null,
): Promise<Response | CursorHttp2Response> {
	const response = await proxyAwareFetch(
		url,
		{ method: "POST", headers, body: body as BodyInit, signal },
		proxyOptions,
	)
	return {
		status: response.status,
		headers: Object.fromEntries(response.headers.entries()),
		body: Buffer.from(await response.arrayBuffer()),
	}
}

export function makeHttp2Request(
	url: string,
	headers: Record<string, string>,
	body: CursorWireBody,
	signal?: AbortSignal,
): Promise<CursorHttp2Response> {
	if (!http2) {
		throw new Error("http2 module not available")
	}
	const HTTP2_TIMEOUT_MS = 60000 // 60s max - prevent hung sessions
	return new Promise((resolve, reject) => {
		const urlObj = new URL(url)
		const client = http2.connect(`https://${urlObj.host}`)
		const chunks: Buffer[] = []
		let responseHeaders: Record<string, string | string[] | undefined> = {}
		let settled = false
		// Ensure client is always closed on settle
		const finish =
			(fn) =>
			(...args) => {
				if (settled) return
				settled = true
				clearTimeout(hangTimeout)
				client.close()
				fn(...args)
			}
		// Hard timeout: close session if server never responds
		const hangTimeout = setTimeout(
			finish(() => {
				reject(new Error("HTTP/2 request timed out"))
			}),
			HTTP2_TIMEOUT_MS,
		)
		client.on("error", finish(reject))
		const req = client.request({
			":method": "POST",
			":path": urlObj.pathname,
			":authority": urlObj.host,
			":scheme": "https",
			...headers,
		})
		req.on("response", (hdrs) => {
			responseHeaders = hdrs
		})
		req.on("data", (chunk) => {
			chunks.push(chunk)
		})
		req.on(
			"end",
			finish(() => {
				resolve({
					status: responseHeaders[":status"],
					headers: responseHeaders,
					body: Buffer.concat(chunks),
				})
			}),
		)
		req.on("error", finish(reject))
		if (signal) {
			const onAbort = finish(() => reject(new Error("Request aborted")))
			signal.addEventListener("abort", onAbort, { once: true })
		}
		req.write(body)
		req.end()
	})
}
/**
 * AgentService (agent.api5.cursor.sh) is HTTP/2-only. Node's fetch/undici speaks
 * HTTP/1.1 and fails with HTTPParserError on the h2 preface - use http2 duplex.
 */

export function openAgentHttp2Stream(url, headers, signal) {
	if (!http2) {
		throw new Error("HTTP/2 is required for Cursor AgentService (endpoint is h2-only)")
	}
	const urlObj = new URL(url)
	const client = http2.connect(`https://${urlObj.host}`)
	type StreamReadResult = { value: Buffer | undefined; done: boolean }
	const chunkQueue: Buffer[] = []
	let waiting: ((result: StreamReadResult) => void) | null = null
	let ended = false
	let streamError: Error | null = null
	let req: import("http2").ClientHttp2Stream | null = null
	const wake = (result) => {
		if (!waiting) return
		const resolve = waiting
		waiting = null
		resolve(result)
	}
	const fail = (error) => {
		if (streamError) return
		streamError = error
		ended = true
		wake(null)
	}
	const close = () => {
		try {
			req?.destroy()
		} catch {}
		try {
			client.close()
		} catch {}
	}
	client.on("error", fail)
	req = client.request({
		":method": "POST",
		":path": urlObj.pathname,
		":authority": urlObj.host,
		":scheme": "https",
		...headers,
	})
	req.on("error", fail)
	req.on("data", (chunk) => {
		if (waiting) wake({ value: chunk, done: false })
		else chunkQueue.push(chunk)
	})
	req.on("end", () => {
		ended = true
		wake({ value: undefined, done: true })
	})
	if (signal) {
		const onAbort = () => {
			fail(new Error("Request aborted"))
			close()
		}
		if (signal.aborted) onAbort()
		else signal.addEventListener("abort", onAbort, { once: true })
	}
	const responseHeaders = new Promise((resolve, reject) => {
		const onEarlyError = (error) => reject(error)
		client.once("error", onEarlyError)
		req.once("error", onEarlyError)
		req.once("response", (hdrs) => {
			client.off("error", onEarlyError)
			req.off("error", onEarlyError)
			resolve(hdrs)
		})
	})
	return {
		responseHeaders,
		write(frame) {
			if (req && !req.destroyed) req.write(Buffer.from(frame))
		},
		end() {
			try {
				if (req && !req.destroyed) req.end()
			} catch {}
		},
		close,
		async read() {
			if (chunkQueue.length) return { value: chunkQueue.shift(), done: false }
			if (ended) {
				if (streamError) throw streamError
				return { value: undefined, done: true }
			}
			const result = await new Promise((resolve) => {
				waiting = resolve
			})
			if (streamError) throw streamError
			return result || { value: undefined, done: true }
		},
	}
}
