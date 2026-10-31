/**
 * The four relay workers, and the contract they all have to honour.
 *
 * A relay is a public HTTPS endpoint that forwards `x-relay-target` +
 * `x-relay-path` to an upstream. It is the egress lane for providers that gate
 * on IP, so it carries chat completions - which means long-lived SSE bodies.
 *
 * Two rules are shared by every provider and live here rather than in four
 * templates that drift:
 *
 * 1. `RELAY_REQUEST_DROP_HEADERS` - the relay's own control headers plus the
 *    hop-by-hop set. Forwarding `connection`/`transfer-encoding` to an upstream
 *    is invalid, and leaving `x-relay-target` on makes the upstream parse our
 *    routing instruction.
 * 2. `RELAY_RESPONSE_DROP_HEADERS` - `fetch` has already decoded the body, so
 *    the upstream's `content-encoding`/`content-length` describe bytes that no
 *    longer exist. Passing them through truncates or garbles every reply.
 *
 * `x-relay-target` must be an https origin. Without that check the deployment
 * is an open proxy: anyone who learns the URL can route arbitrary traffic -
 * including plaintext and internal addresses - through the operator's account.
 *
 * There is deliberately no upstream timeout. These workers exist to carry
 * streams that legitimately run for minutes, so a total-duration abort would
 * kill the traffic the relay was built for; a connect-phase deadline is not
 * expressible through `fetch`.
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

const REQUEST_DROP = JSON.stringify(RELAY_REQUEST_DROP_HEADERS)
const RESPONSE_DROP = JSON.stringify(RELAY_RESPONSE_DROP_HEADERS)
const TARGET_PREFIX = JSON.stringify(RELAY_TARGET_PREFIX)

/** Trim one trailing slash without a regex: the template must survive escaping. */
const TRIM_TRAILING_SLASH = `target.endsWith("/") ? target.slice(0, -1) : target`

/**
 * Vercel, as an `/api` function on the Bun runtime.
 *
 * This is the `fetch` Web Standard export, which Vercel serves on both the
 * Node.js and the Bun runtime - no `export const config = { runtime: "edge" }`.
 * Edge is the wrong lane for a streaming relay: its duration ceiling is a hard
 * few tens of seconds, and Bun is selected by `bunVersion` in `vercel.json`,
 * which Edge ignores. Fluid compute on Bun also carries the long streams this
 * relay exists for.
 */
export const VERCEL_RELAY_CODE = `
const DROP_REQUEST = ${REQUEST_DROP};
const DROP_RESPONSE = ${RESPONSE_DROP};
const TARGET_PREFIX = ${TARGET_PREFIX};

const json = (status, message) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });

export default {
  async fetch(request) {
    const target = request.headers.get("x-relay-target");
    const relayPath = request.headers.get("x-relay-path") || "/";

    if (!target) return json(400, "Missing x-relay-target header");
    if (!target.startsWith(TARGET_PREFIX)) {
      return json(400, "x-relay-target must be an https origin");
    }

    const origin = ${TRIM_TRAILING_SLASH};
    const headers = new Headers(request.headers);
    for (const name of DROP_REQUEST) headers.delete(name);

    const init = { method: request.method, headers };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
      init.duplex = "half";
    }

    try {
      const upstream = await fetch(origin + relayPath, init);
      const out = new Headers(upstream.headers);
      for (const name of DROP_RESPONSE) out.delete(name);
      return new Response(upstream.body, { status: upstream.status, headers: out });
    } catch (error) {
      return json(502, (error && error.message) || "Relay fetch failed");
    }
  },
};
`

/** Cloudflare Workers: same contract, module-worker shape. */
export const CLOUDFLARE_WORKER_CODE = `
const DROP_REQUEST = ${REQUEST_DROP};
const DROP_RESPONSE = ${RESPONSE_DROP};
const TARGET_PREFIX = ${TARGET_PREFIX};

const json = (status, message) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });

export default {
  async fetch(request) {
    const target = request.headers.get("x-relay-target");
    const relayPath = request.headers.get("x-relay-path") || "/";

    if (!target) return json(400, "Missing x-relay-target header");
    if (!target.startsWith(TARGET_PREFIX)) {
      return json(400, "x-relay-target must be an https origin");
    }

    const origin = ${TRIM_TRAILING_SLASH};
    const headers = new Headers(request.headers);
    for (const name of DROP_REQUEST) headers.delete(name);

    const init = { method: request.method, headers };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
      init.duplex = "half";
    }

    try {
      const upstream = await fetch(origin + relayPath, init);
      const out = new Headers(upstream.headers);
      for (const name of DROP_RESPONSE) out.delete(name);
      return new Response(upstream.body, { status: upstream.status, headers: out });
    } catch (error) {
      return json(502, (error && error.message) || "Relay fetch failed");
    }
  },
};
`

/** Deno Deploy: `Deno.serve` takes the handler directly. */
export const DENO_RELAY_CODE = `
const DROP_REQUEST = ${REQUEST_DROP};
const DROP_RESPONSE = ${RESPONSE_DROP};
const TARGET_PREFIX = ${TARGET_PREFIX};

const json = (status, message) =>
  new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });

Deno.serve(async (request) => {
  const target = request.headers.get("x-relay-target");
  const relayPath = request.headers.get("x-relay-path") || "/";

  if (!target) return json(400, "Missing x-relay-target header");
  if (!target.startsWith(TARGET_PREFIX)) {
    return json(400, "x-relay-target must be an https origin");
  }

  const origin = ${TRIM_TRAILING_SLASH};
  const headers = new Headers(request.headers);
  for (const name of DROP_REQUEST) headers.delete(name);

  const init = { method: request.method, headers };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }

  try {
    const upstream = await fetch(origin + relayPath, init);
    const out = new Headers(upstream.headers);
    for (const name of DROP_RESPONSE) out.delete(name);
    return new Response(upstream.body, { status: upstream.status, headers: out });
  } catch (error) {
    return json(502, (error && error.message) || "Relay fetch failed");
  }
});
`
