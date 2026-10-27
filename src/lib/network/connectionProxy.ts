import { normalizeConfigString as normalizeString } from "@/lib/network/normalizeConfigString";
import { getProxyPoolById } from "@/models";
import { pickSmartProxyPoolId } from "./proxyHealth";

// Safely normalize any value into a trimmed string.
// ─── Proxy pool rotation state (in-memory) ─────────────────────────
const rotateState = new Map(); // providerId → { index }

/**
 * Pick one proxy pool ID from a list based on strategy.
 * smart:       sticky — the same pool until it reports a limit/error, then
 *              rotate (see proxyHealth.js). Nothing else moves it.
 * round-robin: cycle sequentially (in-memory, resets on restart)
 * random:      uniform random pick
 * none/single: return first entry
 *
 * `options.excludePoolIds` (a Set) removes pools already tried in THIS request.
 * When every pool is excluded this returns null rather than restarting the list:
 * re-handing a pool that just failed burns the retry budget on a known-bad IP
 * and hides the real exhaustion from the caller, which reads it as a healthy
 * retry loop.
 */
export function pickProxyPoolId(
  poolIds: string[] | null | undefined,
  strategy: string,
  providerId: string,
  options: { excludePoolIds?: Set<string> } = {}
): string | null {
  if (!poolIds || poolIds.length === 0) return null;

  const exclude = options.excludePoolIds instanceof Set && options.excludePoolIds.size > 0
    ? options.excludePoolIds
    : null;
  const candidates = exclude ? poolIds.filter((id) => !exclude.has(id)) : poolIds;
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  if (strategy === "smart") {
    return pickSmartProxyPoolId(candidates, providerId, exclude);
  }

  if (strategy === "round-robin") {
    // `alreadyTried` = this request has already consumed a pool and is retrying.
    // The cursor is an index into the FULL list so a mid-request exclusion never
    // shifts which pool the NEXT request starts at, and a retry walks forward
    // from the cursor without advancing it — otherwise one failure would move
    // the rotation twice and the sequence degrades to p1,p3,p2 instead of p1,p2,p3.
    const alreadyTried = Boolean(exclude);
    const state = rotateState.get(providerId) || { cursor: 0 };
    const start = state.cursor % poolIds.length;
    let picked = null;
    for (let step = 0; step < poolIds.length; step++) {
      const id = poolIds[(start + step) % poolIds.length];
      if (!exclude || !exclude.has(id)) { picked = id; break; }
    }
    if (!alreadyTried) {
      rotateState.set(providerId, { cursor: (poolIds.indexOf(picked) + 1) % poolIds.length });
    }
    return picked;
  }

  if (strategy === "random") {
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  return candidates[0]; // "none" or unknown
}

/**
 * Normalize legacy proxy configuration.
 */
function normalizeLegacyProxy(providerSpecificData: Record<string, unknown> = {}) {
  const connectionProxyEnabled =
    providerSpecificData?.connectionProxyEnabled === true;

  const connectionProxyUrl = normalizeString(
    providerSpecificData?.connectionProxyUrl
  );

  const connectionNoProxy = normalizeString(
    providerSpecificData?.connectionNoProxy
  );

  return {
    connectionProxyEnabled,
    connectionProxyUrl,
    connectionNoProxy,
  };
}

/**
 * Resolve final proxy configuration.
 *
 * Priority:
 * 1. Proxy Pool
 * 2. Legacy Proxy
 * 3. No Proxy
 */
export async function resolveConnectionProxyConfig(
  providerSpecificData: Record<string, unknown> = {}
) {
  try {
    const proxyPoolIdRaw = normalizeString(
      providerSpecificData?.proxyPoolId
    );

    // "__none__" means explicitly disabled
    const proxyPoolId =
      proxyPoolIdRaw === "__none__" ? "" : proxyPoolIdRaw;

    const legacy = normalizeLegacyProxy(providerSpecificData);

    // A strict pool must keep its guarantee even when the pool itself is not
    // usable (inactive, or saved without a url). Otherwise the unusable-pool
    // path below reports strictProxy:false and the request silently leaves
    // over the direct IP — the leak strict mode exists to prevent (#4333).
    let poolStrictProxy = false;

    /**
     * -----------------------------
     * Proxy Pool Resolution
     * -----------------------------
     */
    if (proxyPoolId) {
      const proxyPool = await getProxyPoolById(proxyPoolId);

      const proxyUrl = normalizeString(proxyPool?.proxyUrl);
      const noProxy = normalizeString(proxyPool?.noProxy);

      // Rotating residential proxies (e.g. res-*-sid-XXXXX):
      // Each connection request randomizes the session ID so the proxy gateway
      // assigns a fresh residential exit IP with its own clean rate limit window.
      let effectiveProxyUrl = proxyUrl;
      if (/-sid-\d+/i.test(proxyUrl)) {
        const randSid = Math.floor(100000000 + Math.random() * 900000000);
        effectiveProxyUrl = proxyUrl.replace(/-sid-\d+/i, `-sid-${randSid}`);
      }

      const isValidPool =
        proxyPool &&
        proxyPool.isActive === true &&
        effectiveProxyUrl;

      poolStrictProxy = proxyPool?.strictProxy === true;

      if (isValidPool) {
        /**
         * Vercel/Cloudflare/Deno/Netlify relay proxies use base URL rewriting
         * instead of HTTP_PROXY environment variables.
         */
        if (proxyPool.type === "vercel" || proxyPool.type === "cloudflare" || proxyPool.type === "deno" || proxyPool.type === "netlify") {
          return {
            source: proxyPool.type,

            proxyPoolId,
            proxyPool,

            connectionProxyEnabled: false,
            connectionProxyUrl: "",
            connectionNoProxy: noProxy,

            strictProxy: proxyPool.strictProxy === true,

            relayUrl: effectiveProxyUrl,
            vercelRelayUrl: effectiveProxyUrl,
          };
        }

        /**
         * Standard proxy pool
         */
        return {
          source: "pool",

          proxyPoolId,
          proxyPool,

          connectionProxyEnabled: true,
          connectionProxyUrl: effectiveProxyUrl,
          connectionNoProxy: noProxy,

          strictProxy: proxyPool.strictProxy === true,
        };
      }
    }

    /**
     * -----------------------------
     * Legacy Proxy Fallback
     * -----------------------------
     */
    if (
      legacy.connectionProxyEnabled &&
      legacy.connectionProxyUrl
    ) {
      return {
        source: "legacy",

        proxyPoolId: proxyPoolId || null,
        proxyPool: null,

        strictProxy: poolStrictProxy,

        ...legacy,
      };
    }

    /**
     * -----------------------------
     * No Proxy Config
     * -----------------------------
     */
    return {
      source: "none",

      proxyPoolId: proxyPoolId || null,
      proxyPool: null,

      strictProxy: poolStrictProxy,

      ...legacy,
    };
  } catch (error) {
    console.error(
      "[resolveConnectionProxyConfig] Failed to resolve proxy config:",
      error
    );

    return {
      source: "error",

      proxyPoolId: null,
      proxyPool: null,

      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",

      strictProxy: false,
    };
  }
}
