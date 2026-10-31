/**
 * The four relay workers, and the contract they all have to honour.
 *
 * A relay is a public HTTPS endpoint that forwards `x-relay-target` +
 * `x-relay-path` to an upstream. It is the egress lane for providers that gate
 * on IP, so it carries chat completions - which means long-lived SSE bodies.
 *
 * The rules below are shared by every provider and live here rather than in
 * four templates that drift:
 *
 * 1. `RELAY_REQUEST_DROP_HEADERS` and `RELAY_REQUEST_DROP_PREFIXES` - the
 *    relay's own control headers, the hop-by-hop set no proxy may forward, and
 *    the platform's own trace headers. Forwarding `connection`/
 *    `transfer-encoding` is invalid HTTP; leaving `x-relay-target` on makes the
 *    upstream parse our routing instruction; and the platform's trace headers
 *    announce both the serverless host and the operator's real IP to a provider
 *    that rate-limits on exactly those signals. An ordinary Vercel request
 *    carries seventeen of them, including `x-vercel-ja4-digest` (a TLS
 *    fingerprint), `x-vercel-ip-city`, and `x-vercel-oidc-token`.
 * 2. `RELAY_RESPONSE_DROP_HEADERS` - the upstream's `content-encoding` and
 *    `content-length` describe bytes the transport has already decoded.
 *    Passing them through truncates or garbles every reply.
 *
 * `x-relay-target` must be an https origin. Without that check the deployment
 * is an open proxy: anyone who learns the URL can route arbitrary traffic -
 * including plaintext and internal addresses - through the operator's account.
 *
 * There is deliberately no upstream timeout. These workers exist to carry
 * streams that legitimately run for minutes, so a total-duration abort would
 * kill the traffic the relay was built for; a connect-phase deadline is not
 * expressible through either transport.
 *
 * ## Why Vercel does not use `fetch`
 *
 * Stripping the inbound headers is necessary but not sufficient. Vercel stamps
 * `x-vercel-id` on the function's own *outbound* `fetch` - after the strip has
 * run - so the upstream still learns the region and a per-request trace id.
 * Measured against httpbin, postman-echo and httpbingo: `fetch` leaked
 * `x-vercel-id` and an `x-forwarded-for` chain on every request, while the same
 * hop over `node:https` arrived with none. Cloudflare and Deno have no client
 * sockets and keep `fetch`.
 *
 * Vercel therefore has two hops, and they are not interchangeable:
 *
 * - `VERCEL_RELAY_CODE` (`node:https`) - clean headers, platform TLS. Cheap: no
 *   dependency to install and nothing extra to bundle.
 * - `VERCEL_WREQ_RELAY_CODE` (`wreq-js`) - clean headers *and* a chosen TLS
 *   fingerprint, at the cost of a native binding, an install step, and the
 *   `includeFiles` entry that keeps the binding in the bundle.
 *
 * A relay only needs the second when the upstream decides on the fingerprint.
 * Both carry the request identically; neither leaks the platform.
 */

/** The relay's own headers, plus the hop-by-hop set no proxy may forward. */
export const RELAY_REQUEST_DROP_HEADERS = [
	"x-relay-target",
	"x-relay-path",
	"host",
	"connection",
	"keep-alive",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	// `Forwarded` is the RFC 7239 sibling of `x-forwarded-for` and is not covered
	// by the prefix list below. Vercel fills it in as
	// `for=<operator's real IP>;host=<deployment hostname>`, so leaving it on
	// hands the upstream both facts the relay exists to hide.
	"forwarded",
	// Vercel's per-invocation trace id. Same value as `x-vercel-id`, but a
	// different name, so the `x-vercel-` prefix does not reach it.
	"x-invocation-id",
] as const

/**
 * Prefixes that identify the platform or the operator rather than the request.
 *
 * Matched by prefix because Vercel mints a variable number of `x-vercel-*`
 * headers, and because one list has to cover Cloudflare (`cf-*`) and
 * Netlify (`x-nf-*`) without a second copy per provider.
 */
export const RELAY_REQUEST_DROP_PREFIXES = [
	"x-vercel-",
	"x-forwarded-",
	"x-real-ip",
	"x-nf-",
	"cf-",
] as const

/** Headers that describe the upstream's wire bytes rather than the ones we return. */
export const RELAY_RESPONSE_DROP_HEADERS = [
	"content-encoding",
	"content-length",
	"connection",
	"keep-alive",
	"transfer-encoding",
] as const

/** The only scheme a relay target may use. */
export const RELAY_TARGET_PREFIX = "https://"

/**
 * The filename the worker is deployed as.
 *
 * Vercel only turns an `/api` file into a function when it can infer the
 * language from the extension. An extensionless `api/relay` is uploaded and
 * served as a static asset: `GET /` answers 200 with the worker's own source
 * and `content-type: application/octet-stream`, so every relayed request gets
 * that source instead of a proxy, and POST answers 405. Verified live.
 */
export const RELAY_ENTRYPOINT_FILE = "api/relay.js"

const REQUEST_DROP = JSON.stringify(RELAY_REQUEST_DROP_HEADERS)
const REQUEST_DROP_PREFIXES = JSON.stringify(RELAY_REQUEST_DROP_PREFIXES)
const RESPONSE_DROP = JSON.stringify(RELAY_RESPONSE_DROP_HEADERS)
const TARGET_PREFIX = JSON.stringify(RELAY_TARGET_PREFIX)

/**
 * Everything the platforms share: the constants, the header strip, and the
 * routing rules.
 *
 * The hop itself is a parameter (`send`), so the rules cannot diverge per
 * platform while only the transport differs. `send` resolves to
 * `{ status, headers, body }` and may throw.
 */
const RELAY_CORE = `const DROP_REQUEST = ${REQUEST_DROP};
const DROP_PREFIX = ${REQUEST_DROP_PREFIXES};
const DROP_RESPONSE = ${RESPONSE_DROP};
const TARGET_PREFIX = ${TARGET_PREFIX};

function relayError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sanitize(incoming) {
  const headers = new Headers(incoming);
  for (const name of DROP_REQUEST) headers.delete(name);
  for (const key of [...headers.keys()]) {
    if (DROP_PREFIX.some((prefix) => key.startsWith(prefix))) headers.delete(key);
  }
  return headers;
}

async function relay(request, send) {
  const target = request.headers.get("x-relay-target");
  const relayPath = request.headers.get("x-relay-path") || "/";

  if (!target) return relayError(400, "Missing x-relay-target header");
  if (!target.startsWith(TARGET_PREFIX)) {
    return relayError(400, "x-relay-target must be an https origin");
  }

  const origin = target.endsWith("/") ? target.slice(0, -1) : target;
  const headers = sanitize(request.headers);
  const carriesBody = request.method !== "GET" && request.method !== "HEAD";

  try {
    const upstream = await send(origin + relayPath, request.method, headers, carriesBody ? request.body : null);
    const out = new Headers(upstream.headers);
    for (const name of DROP_RESPONSE) out.delete(name);
    return new Response(upstream.body, { status: upstream.status, headers: out });
  } catch (error) {
    return relayError(502, (error && error.message) || "Relay fetch failed");
  }
}`

/** The hop for platforms whose own `fetch` is not decorated by the host. */
const FETCH_SEND = `async function sendViaFetch(url, method, headers, body) {
  const init = { method, headers };
  if (body) {
    init.body = body;
    init.duplex = "half";
  }
  const response = await fetch(url, init);
  return { status: response.status, headers: response.headers, body: response.body };
}`

/**
 * The hop for Vercel, whose `fetch` is proxied and stamped.
 *
 * Node's `https` is a raw client socket, so the platform never sees the request
 * in order to decorate it. Bodies stream in both directions: the inbound web
 * stream is piped into the socket, and the socket is handed back as a web
 * stream, so a multi-minute SSE reply still flows chunk by chunk.
 *
 * Unlike `fetch`, a raw socket does not decode a compressed reply - and the
 * response rules strip `content-encoding`, so an undecoded body would reach the
 * client as opaque bytes labelled plain. The hop therefore asks for `identity`
 * and still decodes gzip/deflate/brotli, because a server is free to ignore
 * that request.
 */
const NODE_HTTPS_SEND = `async function sendViaNodeHttps(url, method, headers, body) {
  const target = new URL(url);
  const plain = {};
  for (const [key, value] of headers) plain[key] = value;
  plain["accept-encoding"] = "identity";

  return await new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        method,
        headers: plain,
      },
      (incoming) => {
        const out = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (value === undefined) continue;
          if (Array.isArray(value)) {
            for (const item of value) out.append(key, item);
          } else {
            out.set(key, value);
          }
        }
        resolve({
          status: incoming.statusCode,
          headers: out,
          body: Readable.toWeb(decodeUpstream(incoming)),
        });
      },
    );
    request.on("error", reject);
    if (body) {
      Readable.fromWeb(body).pipe(request);
    } else {
      request.end();
    }
  });
}

function decodeUpstream(incoming) {
  const encoding = String(incoming.headers["content-encoding"] || "").toLowerCase();
  if (encoding === "gzip" || encoding === "x-gzip") return incoming.pipe(zlib.createGunzip());
  if (encoding === "deflate") return incoming.pipe(zlib.createInflate());
  if (encoding === "br") return incoming.pipe(zlib.createBrotliDecompress());
  return incoming;
}`

/**
 * Vercel, as an `/api` function on the Bun runtime.
 *
 * This is the `fetch` Web Standard export, which Vercel serves on both the
 * Node.js and the Bun runtime - no `export const config = { runtime: "edge" }`.
 * Edge is the wrong lane for a streaming relay: its duration ceiling is a hard
 * few tens of seconds, and Bun is selected by `bunVersion` in `vercel.json`,
 * which Edge ignores.
 */
export const VERCEL_RELAY_CODE = `import https from "node:https";
import { Readable } from "node:stream";
import zlib from "node:zlib";

${RELAY_CORE}

${NODE_HTTPS_SEND}

export default { fetch: (request) => relay(request, sendViaNodeHttps) };
`

/**
 * The cipher suites the emulated client offers, in the order it offers them.
 *
 * The order is part of the fingerprint - JA4 hashes the list as offered, so the
 * same suites in a different order are a different client. This is the list a
 * local wreq client presents; keeping it here rather than at the call site is
 * what makes the relay's hop indistinguishable from that client's.
 */
export const RELAY_WREQ_CIPHER_LIST = [
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
] as const

/**
 * What a wreq-enabled deployment must install.
 *
 * The binding is listed explicitly, and that is not redundant: it is an optional
 * dependency of `wreq-js`, and an optional dependency the platform decides it
 * does not need is simply not installed - leaving a package that loads and then
 * fails on its first call. Pinned to the same version as the loader.
 */
export const RELAY_WREQ_DEPENDENCIES: Readonly<Record<string, string>> = {
	"wreq-js": "3.2.0",
	"@wreq-js/binding-linux-x64-gnu": "3.2.0",
}

/**
 * What the function bundle must include beyond what tracing finds.
 *
 * The binding is loaded by a computed path, which the bundler cannot follow, so
 * the `.node` file is dropped from the function and every invocation fails with
 * "Failed to load native module". This glob puts it back.
 */
export const RELAY_WREQ_INCLUDE_FILES = "node_modules/@wreq-js/**"

/**
 * The hop for a relay that has to look like a specific client.
 *
 * `wreq.fetch` takes the emulation inline and decodes the reply itself, so this
 * hop needs neither the identity request nor the zlib fallback the `node:https`
 * hop needs. The request body is buffered because it is a small JSON payload,
 * while the reply is the stream that must not be.
 *
 * There is no fallback to another hop when the module fails to load. A relay that
 * silently degrades would report success while presenting the platform's
 * fingerprint - the one thing this transport exists to avoid - so it fails with
 * the loader's message instead.
 */
const WREQ_SEND = `async function sendViaWreq(url, method, headers, body) {
  const wreq = await import("wreq-js");
  const plain = {};
  for (const [key, value] of headers) plain[key] = value;

  const init = { method, headers: plain, emulation: { tlsOptions: { cipherList: CIPHERS } } };
  if (body !== null) init.body = await new Response(body).text();

  const upstream = await wreq.fetch(url, init);
  const out = new Headers();
  if (upstream.headers && typeof upstream.headers.forEach === "function") {
    upstream.headers.forEach((value, key) => out.set(key, value));
  } else {
    for (const [key, value] of Object.entries(upstream.headers || {})) {
      if (value !== undefined) out.set(key, String(value));
    }
  }
  return { status: upstream.status, headers: out, body: upstream.body };
}`

/**
 * Vercel with an emulated TLS stack.
 *
 * Verified live: the JA4 this hop presents is byte-identical to the one a local
 * wreq client presents, and unlike the `node:https` hop it also needs no strip of
 * Vercel's egress stamp, because the platform never sees the request to stamp it.
 */
export const VERCEL_WREQ_RELAY_CODE = `const CIPHERS = ${JSON.stringify(RELAY_WREQ_CIPHER_LIST.join(":"))};

${RELAY_CORE}

${WREQ_SEND}

export default { fetch: (request) => relay(request, sendViaWreq) };
`

/** Cloudflare Workers have no client sockets, so they take the `fetch` hop. */
export const CLOUDFLARE_WORKER_CODE = `${RELAY_CORE}

${FETCH_SEND}

export default { fetch: (request) => relay(request, sendViaFetch) };
`

/** Deno Deploy: the same `fetch` hop, registered through `Deno.serve`. */
export const DENO_RELAY_CODE = `${RELAY_CORE}

${FETCH_SEND}

Deno.serve((request) => relay(request, sendViaFetch));
`

/**
 * The files a Vercel relay is deployed as.
 *
 * The transport decides the worker, the dependency that worker needs, and whether the
 * native binding has to be forced into the bundle — three things that only work together.
 * Deriving them in one place is what stops a caller from changing one and shipping a
 * deployment that fails on its first invocation.
 *
 * `type: "module"` is set only for the wreq variant, because that is the combination
 * measured working: Vercel otherwise compiles the function from ESM to CommonJS, which
 * changes how a module that loads its binding dynamically resolves its exports.
 */
export function vercelRelayFiles(projectName: string, transport: "https" | "wreq") {
	const usesWreq = transport === "wreq"

	const manifest: Record<string, unknown> = { name: projectName, version: "1.0.0" }
	if (usesWreq) {
		manifest.type = "module"
		manifest.dependencies = RELAY_WREQ_DEPENDENCIES
	}

	const config: Record<string, unknown> = {
		rewrites: [{ source: "/(.*)", destination: "/api/relay" }],
		// Bun is selected by this key alone. "1.x" tracks the 1.3 line this repo
		// builds and runs on; "1.4.x" is Bun's Zig-to-Rust rewrite and is not
		// drop-in compatible, so it is not chosen here.
		bunVersion: "1.x",
	}
	if (usesWreq) {
		config.functions = { [RELAY_ENTRYPOINT_FILE]: { includeFiles: RELAY_WREQ_INCLUDE_FILES } }
	}

	return [
		{ file: RELAY_ENTRYPOINT_FILE, data: usesWreq ? VERCEL_WREQ_RELAY_CODE : VERCEL_RELAY_CODE },
		{ file: "package.json", data: JSON.stringify(manifest) },
		{ file: "vercel.json", data: JSON.stringify(config) },
	]
}
