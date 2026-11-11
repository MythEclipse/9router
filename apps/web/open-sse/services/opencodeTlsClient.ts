import { loadRuntimeDep } from "./lazyRuntime.ts"

const OPENCODE_CIPHER_LIST = [
	"TLS_AES_128_GCM_SHA256",
	"TLS_AES_256_GCM_SHA384",
	"TLS_CHACHA20_POLY1305_SHA256",
	"ECDHE-ECDSA-AES128-GCM-SHA256",
	"ECDHE-RSA-AES128-GCM-SHA256",
	"ECDHE-ECDSA-AES256-GCM-SHA384",
	"ECDHE-RSA-AES256-GCM-SHA384",
	"ECDHE-ECDSA-CHACHA20-POLY1305",
	"ECDHE-RSA-CHACHA20-POLY1305",
	"ECDHE-ECDSA-AES128-SHA",
	"ECDHE-RSA-AES128-SHA",
	"ECDHE-ECDSA-AES256-SHA",
	"ECDHE-RSA-AES256-SHA",
	"AES128-GCM-SHA256",
	"AES256-GCM-SHA384",
	"AES128-SHA",
	"AES256-SHA",
].join(":")
const DEFAULT_TIMEOUT_MS = 120_000

type WreqResponse = {
	status: number
	statusText?: string
	headers?: Headers
	body?: BodyInit | null
}

type WreqSession = {
	fetch: (url: string | URL, options: Record<string, unknown>) => Promise<WreqResponse>
	close?: () => void | Promise<void>
	__proxyKey?: string
}

type WreqModule = {
	createSession: (options: {
		emulation: { tlsOptions: { cipherList: string } }
		proxy?: string
	}) => WreqSession
}

// A wreq-js session pins one proxy at creation ("Session proxy cannot be
// changed after creation"), so the cache must be keyed by proxy URL: a proxy
// switch hands out a fresh session instead of silently reusing the old one's
// tunnel. The key "" is the no-proxy (direct) session.
const sessionsByProxy = new Map<string, Promise<WreqSession>>()
const SESSIONS_MAX = 8

export class OpencodeTlsUnavailableError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "OpencodeTlsUnavailableError"
	}
}

function normalizeProxyKey(proxyUrl?: string | null): string {
	const raw = typeof proxyUrl === "string" ? proxyUrl.trim() : ""
	if (!raw) return ""
	try {
		// Credentials are part of the identity (auth context isolates pools), but
		// must never surface in logs or error text. Keep only scheme://host:port.
		const parsed = new URL(raw)
		return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`
	} catch {
		return raw // unverifiable — treat the raw string as its own key
	}
}

async function buildSession(proxyUrl?: string): Promise<WreqSession> {
	const wreq = (await loadRuntimeDep("wreq-js")) as WreqModule
	if (typeof wreq.createSession !== "function") {
		throw new Error("wreq-js runtime is missing createSession")
	}
	const session = await wreq.createSession({
		emulation: { tlsOptions: { cipherList: OPENCODE_CIPHER_LIST } },
		// wreq-js natively tunnels http/https/socks5 proxies at the transport
		// layer, so the impersonated TLS handshake still happens through the
		// proxy — not next to it.
		...(proxyUrl ? { proxy: proxyUrl } : {}),
	})
	return Object.assign(session, { __proxyKey: normalizeProxyKey(proxyUrl) })
}

async function loadSession(proxyUrl: string = ""): Promise<WreqSession> {
	const key = normalizeProxyKey(proxyUrl)
	if (!sessionsByProxy.has(key)) {
		if (sessionsByProxy.size >= SESSIONS_MAX) {
			// Evict oldest: a rotated-out pool identity should not hold connections.
			const oldestKey = sessionsByProxy.keys().next().value
			if (oldestKey !== undefined) {
				const oldest = sessionsByProxy.get(oldestKey)
				sessionsByProxy.delete(oldestKey)
				oldest?.then?.((session) => session.close?.()).catch(() => {})
			}
		}
		const promise = buildSession(proxyUrl).catch((error: unknown) => {
			sessionsByProxy.delete(key)
			throw error
		})
		sessionsByProxy.set(key, promise)
	}
	return sessionsByProxy.get(key)!
}

/** Drop the cached session(s) so the next call builds a fresh one. */
export function resetOpencodeTlsSession(): void {
	const pending = [...sessionsByProxy.values()]
	sessionsByProxy.clear()
	for (const promise of pending) promise?.then?.((session) => session.close?.()).catch(() => {})
}

export async function opencodeTlsFetch(
	url: string | URL,
	init: RequestInit = {},
	{
		signal,
		timeoutMs = DEFAULT_TIMEOUT_MS,
		proxyUrl = "",
	}: { signal?: AbortSignal; timeoutMs?: number; proxyUrl?: string } = {},
): Promise<Response> {
	let session: WreqSession
	try {
		session = await loadSession(proxyUrl)
	} catch (error) {
		const reason = error instanceof Error ? error.message : "unknown"
		throw new OpencodeTlsUnavailableError(
			`wreq-js unavailable (${reason}) — install the optional wreq-js dependency to reach the OpenCode free tier`,
		)
	}

	const options: Record<string, unknown> = {
		method: init.method || "GET",
		headers: init.headers,
		redirect: "follow",
		timeout: timeoutMs,
	}
	if (init.body !== undefined) options.body = init.body
	if (signal) options.signal = signal

	const response = await session.fetch(url, options)
	const headers = new Headers()
	response.headers?.forEach?.((value, key) => headers.set(key, value))
	// Transport-level proof, not selection-level: this is only set after the
	// session that actually holds the proxy tunnel returned a response. The
	// value never carries credentials (normalizeProxyKey strips them).
	if (proxyUrl) headers.set("x-9r-proxy-via", session.__proxyKey || "wreq-js-proxy")
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText || "",
		headers,
	})
}

export const __test__ = { OPENCODE_CIPHER_LIST, normalizeProxyKey, sessionsByProxy }
