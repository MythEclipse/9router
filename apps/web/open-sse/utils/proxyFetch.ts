import { Readable } from "node:stream"
import { normalizeConfigString as normalizeString } from "../../src/lib/network/normalizeConfigString.ts"
import { MEMORY_CONFIG } from "../config/runtimeConfig.ts"

const originalFetch = globalThis.fetch
const proxyDispatchers = new Map()

// Bun's fetch ignores undici's `dispatcher`, so a ProxyAgent silently becomes
// a direct connection — the pool looks configured while every request actually
// spends the host's own IP. Bun has a native `proxy` option instead; pick the
// mechanism the running engine actually honours.
const isBunRuntime = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"

/** Attach proxy egress to a fetch init for whichever engine is running. */
async function withProxy(
	init: RequestInit,
	proxyUrl: string | null,
	insecure = false,
): Promise<RequestInit> {
	if (!proxyUrl) return init
	if (isBunRuntime) return { ...init, proxy: proxyUrl } as RequestInit
	const dispatcher = await getDispatcher(proxyUrl, insecure)
	return { ...init, dispatcher } as unknown as RequestInit
}

// ─── TLS fingerprinting via got-scraping (browser-like JA3) ───────────────
// Disabled: not in use. Kept commented for future re-enable.
// Restore the original block to re-enable per-host JA3 spoofing.
/*
let _gotScraping = null;
let _gotScrapingChecked = false;
const _gotScrapingLoggedHosts = new Set();

async function getGotScraping() {
  if (_gotScrapingChecked) return _gotScraping;
  _gotScrapingChecked = true;
  try {
    const mod = await import("got-scraping");
    _gotScraping = typeof mod.gotScraping === "function" ? mod.gotScraping : null;
    if (_gotScraping) dbg("TLS", "got-scraping loaded (browser-like JA3 enabled)");
  } catch (e) {
    console.warn(`[ProxyFetch] got-scraping unavailable, falling back to native fetch: ${e.message}`);
    _gotScraping = null;
  }
  return _gotScraping;
}

async function gotScrapingFetch(url, options) {
  const gs = await getGotScraping();
  if (!gs) return null;

  const method = (options.method || "GET").toUpperCase();
  const headersInit = options.headers || {};
  const headers = headersInit instanceof Headers
    ? Object.fromEntries(headersInit.entries())
    : { ...headersInit };

  return new Promise((resolve, reject) => {
    let settled = false;
    const stream = gs.stream({
      url,
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : options.body,
      throwHttpErrors: false,
      retry: { limit: 0 },
      timeout: { request: undefined },
      followRedirect: false,
      decompress: true,
    });

    if (options.signal) {
      const onAbort = () => { try { stream.destroy(new Error("aborted")); } catch { } };
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    stream.once("response", (res) => {
      if (settled) return;
      settled = true;
      const resHeaders = new Headers();
      for (const [k, v] of Object.entries(res.headers || {})) {
        if (Array.isArray(v)) v.forEach((x) => resHeaders.append(k, String(x)));
        else if (v != null) resHeaders.set(k, String(v));
      }
      const body = Readable.toWeb(stream);
      resolve(new Response(body, { status: res.statusCode, statusText: res.statusMessage || "", headers: resHeaders }));
    });

    stream.once("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

async function tryGotScrapingFetch(url, options) {
  try {
    const res = await gotScrapingFetch(url, options);
    if (res) {
      try {
        const host = new URL(typeof url === "string" ? url : url.toString()).hostname;
        if (!_gotScrapingLoggedHosts.has(host)) {
          _gotScrapingLoggedHosts.add(host);
          dbg("TLS", `using got-scraping for ${host}`);
        }
      } catch { }
    }
    return res;
  } catch (e) {
    console.warn(`[ProxyFetch] got-scraping request failed, fallback to native fetch: ${e.message}`);
    return null;
  }
}
*/

// DNS cache - use Map to avoid prototype pollution via malformed hostnames
const DNS_CACHE = new Map()
const TLS_CERT_ERRORS = new Set([
	"SELF_SIGNED_CERT_IN_CHAIN",
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"UNABLE_TO_GET_ISSUER_CERT",
	"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
	"CERT_HAS_EXPIRED",
	"ERR_TLS_CERT_ALTNAME_INVALID",
])

function isTlsCertError(err) {
	const code = err?.cause?.code || err?.code
	return TLS_CERT_ERRORS.has(code)
}
const MITM_BYPASS_HOSTS = [
	"cloudcode-pa.googleapis.com",
	"daily-cloudcode-pa.googleapis.com",
	"api.individual.githubcopilot.com",
	"q.us-east-1.amazonaws.com",
	"codewhisperer.us-east-1.amazonaws.com",
	"api2.cursor.sh",
]
const GOOGLE_DNS_SERVERS = ["8.8.8.8", "8.8.4.4"]
const HTTPS_PORT = 443
const HTTP_SUCCESS_MIN = 200
const HTTP_SUCCESS_MAX = 300

/**
 * Resolve real IP using Google DNS (bypass system DNS)
 */
async function resolveRealIP(hostname) {
	const cached = DNS_CACHE.get(hostname)
	if (cached && Date.now() < cached.expiry) return cached.ip

	try {
		const dns = await import("node:dns")
		const { promisify } = await import("node:util")
		const resolver = new dns.Resolver()
		resolver.setServers(GOOGLE_DNS_SERVERS)
		const resolve4 = promisify(resolver.resolve4.bind(resolver))
		const addresses = await resolve4(hostname)
		DNS_CACHE.set(hostname, { ip: addresses[0], expiry: Date.now() + MEMORY_CONFIG.dnsCacheTtlMs })
		return addresses[0]
	} catch (error) {
		console.warn(`[ProxyFetch] DNS resolve failed for ${hostname}:`, error.message)
		return null
	}
}

/**
 * Check if request should bypass MITM DNS redirect
 */
function shouldBypassMitmDns(url) {
	try {
		const hostname = new URL(url).hostname
		return MITM_BYPASS_HOSTS.some((host) => hostname.includes(host))
	} catch {
		return false
	}
}

export function shouldBypassByNoProxy(targetUrl, noProxyValue) {
	const noProxy = normalizeString(noProxyValue)
	if (!noProxy) return false

	let hostname
	let port
	try {
		const parsed = new URL(targetUrl)
		hostname = parsed.hostname.toLowerCase()
		port = parsed.port || (parsed.protocol === "https:" ? "443" : "80")
	} catch {
		return false
	}
	const patterns = noProxy
		.split(",")
		.map((p) => p.trim().toLowerCase())
		.filter(Boolean)

	return patterns.some((rawPattern) => {
		if (rawPattern === "*") return true

		// `host:port` is standard NO_PROXY syntax; only bypass when the port matches.
		let pattern = rawPattern
		const portMatch = pattern.match(/^(.*):(\d+)$/)
		if (portMatch) {
			if (portMatch[2] !== port) return false
			pattern = portMatch[1]
		}

		// `*.example.com` is the most common way to write a suffix rule; treat it
		// exactly like the leading-dot form instead of requiring a literal `*` host.
		if (pattern.startsWith("*.")) pattern = pattern.slice(1)

		if (pattern.startsWith(".")) return hostname.endsWith(pattern) || hostname === pattern.slice(1)
		return hostname === pattern || hostname.endsWith(`.${pattern}`)
	})
}

/**
 * Get proxy URL from environment
 */
function getEnvProxyUrl(targetUrl) {
	const noProxy = process.env.NO_PROXY || process.env.no_proxy
	if (shouldBypassByNoProxy(targetUrl, noProxy)) return null

	let protocol
	try {
		protocol = new URL(targetUrl).protocol
	} catch {
		return null
	}

	if (protocol === "https:") {
		return (
			process.env.HTTPS_PROXY ||
			process.env.https_proxy ||
			process.env.ALL_PROXY ||
			process.env.all_proxy
		)
	}

	return (
		process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy
	)
}

/**
 * Normalize proxy URL (allow host:port)
 */
function normalizeProxyUrl(proxyUrl) {
	const normalizedInput = normalizeString(proxyUrl)
	if (!normalizedInput) return null

	try {
		new URL(normalizedInput)
		return normalizedInput
	} catch {
		// Allow "127.0.0.1:7890" style values
		return `http://${normalizedInput}`
	}
}

function resolveConnectionProxyUrl(targetUrl, proxyOptions) {
	const enabled = proxyOptions?.enabled === true || proxyOptions?.connectionProxyEnabled === true
	if (!enabled) return null

	const proxyUrlRaw = normalizeString(proxyOptions?.url ?? proxyOptions?.connectionProxyUrl)
	if (!proxyUrlRaw) return null

	const noProxy = normalizeString(proxyOptions?.noProxy ?? proxyOptions?.connectionNoProxy)
	if (noProxy && shouldBypassByNoProxy(targetUrl, noProxy)) return null

	return normalizeProxyUrl(proxyUrlRaw)
}

/**
 * Create proxy dispatcher lazily (undici-compatible)
 */
async function getDispatcher(proxyUrl, insecure = false) {
	const normalized = normalizeProxyUrl(proxyUrl)
	if (!normalized && !insecure) return null

	const key = `${normalized || "direct"}::${insecure ? "insecure" : "secure"}`
	if (!proxyDispatchers.has(key)) {
		// Evict oldest entry if max size reached. The evicted dispatcher owns
		// sockets/agents, so it must be closed or every eviction leaks them.
		if (proxyDispatchers.size >= MEMORY_CONFIG.proxyDispatchersMaxSize) {
			const oldestKey = proxyDispatchers.keys().next().value
			const oldest = proxyDispatchers.get(oldestKey)
			proxyDispatchers.delete(oldestKey)
			try {
				oldest?.close?.()
			} catch {
				/* already closing */
			}
		}
		const { Agent, ProxyAgent } = await import("undici")
		const connect = insecure ? { rejectUnauthorized: false } : undefined
		const dispatcher = normalized
			? new ProxyAgent({ uri: normalized, ...(insecure ? { requestTls: connect } : {}) })
			: new Agent({ connect })
		proxyDispatchers.set(key, dispatcher)
	}

	return proxyDispatchers.get(key)
}

/** Transport override for the direct (non-proxy) egress path. */
type DirectFetchFn = (url: string | URL, options: RequestInit) => Promise<Response>

async function fetchWithTlsFallback(
	url,
	options,
	proxyUrl,
	directFetch: DirectFetchFn | null = null,
) {
	try {
		// Protocol adapters may need Node's HTTP/1 transport on the direct path.
		// Keep proxy/no-proxy resolution and strict-proxy enforcement here.
		if (!proxyUrl && (directFetch || options.directFetch)) {
			return await (directFetch || options.directFetch)(url, options)
		}
		return await originalFetch(url, await withProxy(options, proxyUrl))
	} catch (err) {
		const isStrictSsl =
			options.strictTls === true || process.env.STRICT_SSL === "true" || process.env.STRICT_SSL === "1"
		if (!isStrictSsl && isTlsCertError(err)) {
			if (options.body && typeof options.body.getReader === "function" && options.body.locked) {
				throw err
			}
			// ponytail: in-memory insecure agent fallback for self-signed MITM corporate/antivirus certs
			console.warn(
				`[ProxyFetch] TLS cert verification failed (${err.cause?.code || err.code}), retrying with insecure TLS: ${url}`,
			)
			return await originalFetch(url, await withProxy(options, proxyUrl, true))
		}
		throw err
	}
}

/**
 * Create HTTPS request with manual socket connection (bypass DNS)
 */
async function createBypassRequest(parsedUrl, realIP, options) {
	const httpsModule = await import("node:https")
	const netModule = await import("node:net")
	// CJS modules expose exports via .default in ESM dynamic import context
	const https = httpsModule.default ?? httpsModule
	const net = netModule.default ?? netModule

	return new Promise((resolve, reject) => {
		const socket = new net.Socket()

		socket.connect(HTTPS_PORT, realIP, () => {
			const reqOptions = {
				socket,
				// SNI + cert hostname are validated against the hostname the caller
				// asked for, not the IP we connected to. This keeps the DNS-bypass
				// (avoiding /etc/hosts MITM) while still rejecting on-path attackers
				// that present a different cert. The MITM_BYPASS_HOSTS targets are
				// all public-CA-issued (Google / GitHub / AWS / Cursor) so default
				// verification works without any extra trust store.
				servername: parsedUrl.hostname,
				path: parsedUrl.pathname + parsedUrl.search,
				method: options.method || "POST",
				headers: {
					...options.headers,
					Host: parsedUrl.hostname,
				},
			}

			const req = https.request(reqOptions, (res) => {
				const response = {
					ok: res.statusCode >= HTTP_SUCCESS_MIN && res.statusCode < HTTP_SUCCESS_MAX,
					status: res.statusCode,
					statusText: res.statusMessage,
					headers: new Map(Object.entries(res.headers)),
					body: Readable.toWeb(res),
					text: async () => {
						const chunks = []
						for await (const chunk of res) chunks.push(chunk)
						return Buffer.concat(chunks).toString()
					},
					json: async () => JSON.parse(await response.text()),
				}
				resolve(response)
			})

			req.on("error", reject)
			if (options.body) {
				req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body))
			}
			req.end()
		})

		socket.on("error", reject)
	})
}

// OpenCode's free-tier gate answers 403 `FreeTierError` when the request
// exits from an IP it has flagged — the transport itself succeeded, so the
// proxy-failure fallback below never sees it and every retry keeps leaving
// through the same flagged proxy. Live measurement (#4983): identical body and
// headers in the same minute — flagged pool egress → 403 FreeTierError,
// direct egress → 200.
const FREE_TIER_ERROR_MARKER = "FreeTierError"

/** Rebuild a response whose body we buffered while inspecting it. */
function bufferedResponse(text, original) {
	const headers = new Headers(original.headers)
	// The body was decoded while reading, so upstream framing no longer applies.
	headers.delete("content-length")
	headers.delete("content-encoding")
	return new Response(text, { status: original.status, statusText: original.statusText, headers })
}

/**
 * After a proxied attempt, replay once on the direct egress when upstream
 * rejected the *proxy's IP* (403 FreeTierError). A body already consumed by
 * the first attempt cannot be resent, and strictProxy keeps its contract of
 * never leaving over another path — both return the rejection as-is.
 */
async function replayFreeTierRejectionDirect(url, options, proxied, _proxyUrl, directFetch) {
	if (proxied.status !== 403) return proxied
	let text
	try {
		text = await proxied.text()
	} catch {
		return proxied
	}
	if (!text.includes(FREE_TIER_ERROR_MARKER)) return bufferedResponse(text, proxied)
	if (options?.body && typeof options.body.getReader === "function" && options.body.locked) {
		return bufferedResponse(text, proxied)
	}
	console.warn(
		`[ProxyFetch] Proxy egress rejected by the OpenCode free-tier gate (403 FreeTierError); replaying direct: ${targetHost(url)}`,
	)
	try {
		return await (directFetch || originalFetch)(url, options)
	} catch (directError) {
		// The direct replay failed outright — surface the original rejection.
		console.warn(`[ProxyFetch] Direct replay failed: ${directError.message}`)
		return bufferedResponse(text, proxied)
	}
}

function targetHost(url) {
	try {
		return new URL(typeof url === "string" ? url : url.toString()).host
	} catch {
		return String(url)
	}
}

/**
 * Rewrite an upstream request into the relay's header contract.
 *
 * Client-side forwarding headers are dropped so the relay cannot echo our own
 * IP to the upstream gate.
 */
function buildRelayRequest(
	relayUrl: string,
	targetUrl: string,
	options: RequestInit,
): [string, RequestInit] {
	const parsed = new URL(targetUrl)
	const baseHeaders: Record<string, string> =
		options.headers instanceof Headers
			? Object.fromEntries(options.headers.entries())
			: ({ ...(options.headers || {}) } as Record<string, string>)
	const relayHeaders: Record<string, string> = {
		...baseHeaders,
		"x-relay-target": `${parsed.protocol}//${parsed.host}`,
		"x-relay-path": `${parsed.pathname}${parsed.search}`,
	}
	for (const key of Object.keys(relayHeaders)) {
		const lower = key.toLowerCase()
		if (lower.startsWith("x-forwarded-") || lower === "x-real-ip" || lower.startsWith("x-vercel-")) {
			delete relayHeaders[key]
		}
	}
	return [relayUrl, { ...options, headers: relayHeaders }]
}

export async function proxyAwareFetch(
	url: string | URL,
	options: RequestInit = {},
	proxyOptions = null,
	directFetch: DirectFetchFn | null = null,
) {
	const targetUrl = typeof url === "string" ? url : url.toString()

	const connectionProxyUrl = resolveConnectionProxyUrl(targetUrl, proxyOptions)
	const envProxyUrl = connectionProxyUrl ? null : normalizeProxyUrl(getEnvProxyUrl(targetUrl))
	const proxyUrl = connectionProxyUrl || envProxyUrl
	const proxyWasAssigned = !!(proxyOptions?.proxyPoolId || proxyOptions?.enabled)
	if (!proxyUrl && proxyOptions?.strictProxy === true && proxyWasAssigned) {
		throw new Error("[ProxyFetch] strictProxy requires an active proxy URL; none resolved")
	}

	// Relay lane. The Vercel deploy path parks its URL in vercelRelayUrl, while
	// Cloudflare/Deno/Netlify pools and the generic connection resolver fill
	// relayUrl. Reading only vercelRelayUrl silently ignored every non-Vercel
	// relay: the request fell through to a direct dial and hit the upstream gate
	// as if no relay had been configured at all.
	//
	// The relay hop is the request's route to the relay; it is not a substitute
	// for the egress proxy. Dialling the relay directly would spend the host's
	// own IP on behalf of a pool that exists to avoid exactly that, so the hop
	// rides the proxy when one is configured.
	const relayUrl =
		normalizeString(proxyOptions?.vercelRelayUrl) || normalizeString(proxyOptions?.relayUrl)
	if (relayUrl) {
		const [hopUrl, hopInit] = buildRelayRequest(relayUrl, targetUrl, options)
		if (!proxyUrl) return originalFetch(hopUrl, hopInit)
		const res = await originalFetch(hopUrl, await withProxy(hopInit, proxyUrl))
		if (res.status === 407) {
			throw new Error("HTTP 407 Proxy Authentication Required (credentials invalid or plan expired)")
		}
		return res
	}

	// MITM DNS bypass: for known MITM-intercepted hosts, resolve real IP to avoid DNS spoof
	if (shouldBypassMitmDns(targetUrl)) {
		if (proxyUrl) {
			// Proxy resolves DNS externally (not affected by /etc/hosts) - use proxy directly
			try {
				return await fetchWithTlsFallback(url, options, proxyUrl, directFetch)
			} catch (proxyError) {
				if (proxyOptions?.strictProxy === true) {
					throw new Error(
						`[ProxyFetch] Proxy required but failed (strictProxy=true): ${proxyError.message}`,
					)
				}
				console.warn(`[ProxyFetch] Proxy failed, falling back to direct bypass: ${proxyError.message}`)
			}
		}
		// No proxy - manually resolve real IP to bypass DNS spoof
		try {
			const parsedUrl = new URL(targetUrl)
			const realIP = await resolveRealIP(parsedUrl.hostname)
			if (realIP) return await createBypassRequest(parsedUrl, realIP, options)
		} catch (error) {
			console.warn(`[ProxyFetch] MITM bypass failed: ${error.message}`)
		}
	}

	if (proxyUrl) {
		try {
			const res = await originalFetch(url as string | URL, await withProxy(options, proxyUrl))
			if (res.status === 407) {
				throw new Error("HTTP 407 Proxy Authentication Required (credentials invalid or plan expired)")
			}
			// strictProxy never leaves the configured path — pass the rejection through.
			if (proxyOptions?.strictProxy === true) return res
			return await replayFreeTierRejectionDirect(url, options, res, proxyUrl, directFetch)
		} catch (proxyError) {
			// If a proxy was configured, never fall back to direct egress which leaks
			// the host's main IP.
			throw new Error(
				`[ProxyFetch] Proxy required but failed (${proxyError.message}); direct fallback blocked to protect main IP.`,
			)
		}
	}

	// got-scraping disabled - use native fetch directly
	// (Re-enable per-host by wrapping with tryGotScrapingFetch when needed)
	if (directFetch) return directFetch(url, options)
	return fetchWithTlsFallback(url, options, null, directFetch)
}

/**
 * Patched global fetch with env-proxy support and MITM DNS bypass
 */
async function patchedFetch(url, options = {}) {
	return proxyAwareFetch(url, options, null)
}

// Idempotency guard - only patch once to avoid wrapping multiple times
if (globalThis.fetch !== patchedFetch) {
	globalThis.fetch = patchedFetch
}

export default patchedFetch
