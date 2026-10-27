function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

// The schemes the SERVING RUNTIME can actually speak — not the list node's
// undici would accept. On a `bun --bun` process (how this app is started),
// `fetch(url, { proxy })` rejects socks4/socks4a/socks5/socks5h with
// `UnsupportedProxyProtocol`. Accepting them here is not a harmless
// permissiveness: a configured-but-unusable proxy trips the no-leak policy in
// proxyFetch, which blocks the direct fallback, so EVERY request through such a
// pool fails with no escape hatch while the dashboard reports the pool healthy.
// Keep this list and the transport in agreement — see isSupportedProxyScheme.
const ALLOWED_PROXY_SCHEMES = ["http:", "https:"];

/**
 * Schemes the settings validator accepts. socks* are rejected before they can
 * reach a request, so the failure surfaces at configuration time (a clear
 * validation error) instead of at every request afterwards.
 */
export function isSupportedProxyScheme(url) {
  if (!url) return false;
  try {
    return ALLOWED_PROXY_SCHEMES.includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

function validateProxyUrl(url) {
  if (!url) return null;
  if (/[\n\r`$]/.test(url)) return null;
  try {
    const parsed = new URL(url);
    if (!ALLOWED_PROXY_SCHEMES.includes(parsed.protocol)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

export function applyOutboundProxyEnv({
  outboundProxyEnabled,
  outboundProxyUrl,
  outboundNoProxy,
}: {
  outboundProxyEnabled?: boolean;
  outboundProxyUrl?: string;
  outboundNoProxy?: string;
} = {}): void {
  if (typeof process === "undefined" || !process.env) return;
  const enabled = Boolean(outboundProxyEnabled);
  const proxyUrl = normalizeString(outboundProxyUrl);
  const noProxy = normalizeString(outboundNoProxy);

  // If disabled, only clear env vars we previously managed.
  if (!enabled) {
    if (process.env.NINE_ROUTER_PROXY_MANAGED === "1") {
      delete process.env.HTTP_PROXY;
      delete process.env.HTTPS_PROXY;
      delete process.env.ALL_PROXY;
      delete process.env.NO_PROXY;
      delete process.env.NINE_ROUTER_PROXY_MANAGED;
      delete process.env.NINE_ROUTER_PROXY_URL;
      delete process.env.NINE_ROUTER_NO_PROXY;
    }
    return;
  }

  // When enabled:
  // - If values are provided, write them and mark as managed
  // - If values are empty, do not touch externally-provided env,
  //   but do clear values we previously managed.
  const wasManaged = process.env.NINE_ROUTER_PROXY_MANAGED === "1";
  let managed = false;

  if (wasManaged) {
    if (!proxyUrl) {
      delete process.env.HTTP_PROXY;
      delete process.env.HTTPS_PROXY;
      delete process.env.ALL_PROXY;
      delete process.env.NINE_ROUTER_PROXY_URL;
    }
    if (!noProxy) {
      delete process.env.NO_PROXY;
      delete process.env.NINE_ROUTER_NO_PROXY;
    }
  }

  if (proxyUrl) {
    const validated = validateProxyUrl(proxyUrl);
    if (validated) {
      process.env.HTTP_PROXY = validated;
      process.env.HTTPS_PROXY = validated;
      process.env.ALL_PROXY = validated;
      process.env.NINE_ROUTER_PROXY_URL = validated;
      managed = true;
    }
  }

  if (noProxy) {
    process.env.NO_PROXY = noProxy;
    process.env.NINE_ROUTER_NO_PROXY = noProxy;
    managed = true;
  }

  if (managed) {
    process.env.NINE_ROUTER_PROXY_MANAGED = "1";
  } else if (wasManaged) {
    // If we previously managed env but now cleared everything, drop the marker.
    delete process.env.NINE_ROUTER_PROXY_MANAGED;
  }
}
