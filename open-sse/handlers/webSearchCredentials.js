/**
 * Web search credential + provider resolution.
 *
 * The search provider is frequently NOT the chat provider serving the request
 * (Claude Code routed to, say, kiro, with search run through searxng). Like
 * safeguardsCredentials.js, credentials are resolved at call time from the
 * provider store — never inline, never reused from the chat lane, and never
 * passed in from a test.
 *
 * The search provider id itself comes from the runtime credential resolver
 * injected by the caller (chatCore passes one), defaulting to the request's own
 * provider when that provider can actually search.
 */

import { AI_PROVIDERS } from "../../src/shared/constants/providers.js";

/** Providers that can serve a search, cheapest/most-local first. */
const PREFERRED_SEARCH_PROVIDERS = [
  "searxng", "brave-search", "tavily", "serper", "exa", "linkup",
  "youcom", "searchapi", "google-pse", "xquik", "ollama-search", "tinyfish",
];

/** True when this provider entry can actually run a search. */
export function supportsSearch(providerId) {
  const p = AI_PROVIDERS[providerId];
  if (!p) return false;
  return !!p.searchConfig || !!p.searchViaChat;
}

/**
 * Decide which provider runs the search.
 *
 * @param {object} args
 * @param {string} args.providerId     explicit setting, wins outright
 * @param {string} args.requestProvider the provider serving this chat request
 * @param {object} args.candidates     provider ids with live credentials, best-first
 * @returns {{providerId: string|null, provider: object|null, source: string}}
 */
export function resolveSearchProvider({ providerId, requestProvider, candidates = [] }) {
  // 1. Explicit setting wins outright.
  if (providerId && supportsSearch(providerId)) {
    return { providerId, provider: AI_PROVIDERS[providerId], source: "settings" };
  }

  // 2. A connected dedicated search engine, preferring the well-known ones so
  //    the choice is stable across requests instead of candidate order.
  //
  //    This outranks the request's own provider on purpose. `searchViaChat`
  //    (openai -> gpt-4o-mini, etc.) only "works" when that chat account
  //    happens to be connected AND the model has search access — neither is
  //    guaranteed, and an unconnected provider makes the whole search fail.
  //    A provider in `candidates` has live credentials by construction.
  const usable = (Array.isArray(candidates) ? candidates : []).filter((id) => supportsSearch(id));
  if (usable.length) {
    for (const preferred of PREFERRED_SEARCH_PROVIDERS) {
      if (usable.includes(preferred)) {
        return { providerId: preferred, provider: AI_PROVIDERS[preferred], source: "auto" };
      }
    }
    return { providerId: usable[0], provider: AI_PROVIDERS[usable[0]], source: "auto" };
  }

  // 3. Fall back to the request's own provider. `hasCredentials` lets the
  //    caller keep an unconnected provider from silently swallowing the search.
  if (requestProvider && supportsSearch(requestProvider)) {
    return {
      providerId: requestProvider,
      provider: AI_PROVIDERS[requestProvider],
      source: "request-provider",
      needsCredentials: true,
    };
  }

  return { providerId: null, provider: null, source: "none" };
}

/**
 * Resolve credentials for the search provider.
 *
 * Mirrors src/sse/handlers/search.js: no-auth providers bypass the lookup
 * entirely, and search providers that piggyback on a related chat provider's key
 * (`credentialFallback`) fall back to that provider's credentials.
 *
 * The lock key is namespaced so a search failure cannot take the chat provider
 * offline for chat traffic.
 *
 * @param {object} args
 * @param {object} args.provider         AI_PROVIDERS entry
 * @param {string} args.providerId
 * @param {function} args.getProviderCredentials  (providerId, excludeIds, lockKey) => credentials|null
 * @returns {Promise<{credentials: object|null, providerId: string, lockKey: string}>}
 */
export async function resolveSearchCredentials({
  provider,
  providerId,
  getProviderCredentials,
}) {
  const lockKey = `websearch:${providerId}`;

  if (provider?.noAuth) {
    return { credentials: null, providerId, lockKey, noAuth: true };
  }

  // Fail-safe: a credential-store failure must degrade to "no credentials" and
  // let the caller report unavailable. Throwing here would take down a chat
  // turn that merely asked a question.
  const lookup = async (id) => {
    try {
      return await getProviderCredentials(id, new Set(), { lockKey });
    } catch {
      return null;
    }
  };

  let credentials = await lookup(providerId);

  const fallbackProviderId = provider?.credentialFallback;
  if (!credentials && fallbackProviderId) {
    credentials = await lookup(fallbackProviderId);
  }

  return { credentials: credentials || null, providerId, lockKey };
}