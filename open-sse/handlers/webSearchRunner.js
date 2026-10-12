/**
 * Web search — the `runSearch` executor handed to the bridge and stream layers.
 *
 * Wraps handlers/search/index.js (handleSearchCore) with provider selection and
 * credential resolution so callers only pass a query. Domain filters from the
 * client's tool declaration are honoured here, since they are request policy
 * rather than engine policy.
 *
 * Credentials are always resolved at call time through the injected resolver —
 * this module never sees a literal key.
 */

import { handleSearchCore } from "./search/index.js";
import { resolveSearchProvider, resolveSearchCredentials, supportsSearch } from "./webSearchCredentials.js";

/**
 * Build a `runSearch({query, plan}) => SearchResult[]` closure.
 *
 * @param {object} params
 * @param {object} params.webSearchPlan
 * @param {string} params.requestProvider provider serving the chat request
 * @param {Function} params.getProviderCredentials (providerId, excludeIds, lockKey) => creds|null
 * @param {Function} [params.listCandidateProviders] () => provider ids with live credentials
 * @param {object} [params.log]
 * @returns {Function}
 */
export function createSearchRunner({
  webSearchPlan,
  requestProvider,
  getProviderCredentials = defaultCredentialResolver,
  runSearchViaEndpoint = null,
  listCandidateProviders,
  log,
  // The caller's gateway key. The /v1/search handler authenticates it and
  // resolves combo permissions from it, so the endpoint path must forward it.
  requestApiKey = null,
}) {
  // Resolved once per request: provider choice must not change mid-turn, or two
  // searches in one turn could hit different engines.
  let resolved = null;
  // Target for the /v1/search endpoint path: the operator's configured provider
  // or combo, else the connected search engine we auto-selected. Never the chat
  // provider — that lane (antigravity, openai, …) usually has no search access
  // at all, and asking it produced a silent empty result set.
  let resolvedTargetModel = null;

  async function ensureProvider() {
    if (resolved) return resolved;

    const candidates = typeof listCandidateProviders === "function"
      ? await listCandidateProviders()
      : [];

    // An operator-pinned target (often a combo name like "search-combo-1") is
    // not in AI_PROVIDERS, so it must not be run through provider-id selection.
    // The endpoint path handles it; here we only auto-select a fallback engine.
    const pinnedTarget = webSearchPlan?.searchTargetModel || null;
    const selection = resolveSearchProvider({
      providerId: pinnedTarget && supportsSearch(pinnedTarget) ? pinnedTarget : null,
      requestProvider,
      candidates,
    });

    resolvedTargetModel = pinnedTarget || selection.providerId;

    if (!selection.providerId) {
      resolved = { error: "no search provider configured" };
      return resolved;
    }

    const creds = await resolveSearchCredentials({
      provider: selection.provider,
      providerId: selection.providerId,
      getProviderCredentials,
    });

    if (!creds.credentials && !creds.noAuth) {
      log?.warn?.("WEBSEARCH", `no credentials for search provider ${selection.providerId}`);
      resolved = { error: `no credentials for search provider ${selection.providerId}` };
      return resolved;
    }

    resolved = {
      providerId: selection.providerId,
      provider: selection.provider,
      credentials: creds.credentials,
    };
    return resolved;
  }

  return async function runSearch({ query, searchType }) {
    const body = buildSearchBody({ query, webSearchPlan, searchType });

    // Resolve the target BEFORE dispatching. ensureProvider is memoised and
    // side-effect free apart from caching, so calling it here costs nothing and
    // guarantees `resolvedTargetModel` is populated — previously the endpoint
    // path ran first and fell back to the chat provider, which on this
    // deployment is `antigravity`: no search access, silently zero results.
    const sel = await ensureProvider();

    // Preferred path: dispatch through the app's /v1/search handler. It is the
    // only layer that understands combos (e.g. "search-combo-1"), per-key access
    // and combo fallback, so routing around it silently drops all three — a
    // combo name is not in AI_PROVIDERS and can never be selected here.
    if (typeof runSearchViaEndpoint === "function") {
      if (sel.error && !webSearchPlan?.searchTargetModel) {
        // Nothing connected can search — surface it rather than calling the
        // endpoint with a provider that cannot search.
        throw new Error(sel.error);
      }
      const payload = await runSearchViaEndpoint(
        {
          model: webSearchPlan?.searchTargetModel || resolvedTargetModel || requestProvider,
          ...body,
        },
        { apiKey: requestApiKey },
      );
      return applyDomainFilters(readResults(payload), webSearchPlan);
    }

    if (sel.error) throw new Error(sel.error);

    const result = await handleSearchCore({
      body,
      provider: sel.provider,
      providerConfig: sel.provider.searchConfig,
      credentials: sel.credentials,
      log,
    });

    if (!result?.success) {
      const message = result?.error || result?.response?.body || "search failed";
      throw new Error(`web search failed: ${typeof message === "string" ? message : "unknown error"}`);
    }

    const payload = readResults(result);
    return applyDomainFilters(payload, webSearchPlan);
  };
}

/**
 * Last-resort credential lookup when no resolver was injected. Kept as a named
 * function so the missing-resolver case fails loudly with a clear message
 * instead of a TypeError deep inside the search dispatcher.
 */
async function defaultCredentialResolver(providerId, excludeIds, lockKey) {
  throw new Error(
    `no credential resolver available for search provider "${providerId}"` +
    (lockKey ? ` (lock ${lockKey})` : "")
  );
}

/** Translate the Anthropic tool declaration into the search dispatcher's body. */
/**
 * Translate the Anthropic web_search tool declaration into 9router's
 * `/v1/search` body shape (see open-sse/handlers/search/index.js `params`).
 *
 * Field names are the endpoint's, not Anthropic's: `allowed_domains` becomes
 * `domain_filter`, and the tool's optional `search_type` passes through so a
 * client asking for news gets news.
 */
function buildSearchBody({ query, webSearchPlan, searchType }) {
  const body = {
    query,
    max_results: webSearchPlan?.defaultMaxResults,
  };
  const allowed = webSearchPlan?.allowedDomains;
  if (Array.isArray(allowed) && allowed.length) body.domain_filter = allowed;
  // A per-call search_type wins over the declaration default; absent one lets
  // handleSearchCore fall back to the provider's own default type.
  const type = searchType || webSearchPlan?.searchType;
  if (type) body.search_type = type;
  return body;
}

/** Pull the results array out of handleSearchCore's success envelope. */
function readResults(result) {
  const raw = result?.data ?? result?.results ?? result;
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.results)) return raw.results;
  return [];
}

/**
 * Apply `allowed_domains` / `blocked_domains` from the tool declaration.
 *
 * Done here rather than pushed to the engine because engines honour different
 * subsets: the client's declaration is a promise about what the model may see,
 * so 9router enforces it regardless of what the engine returned.
 */
function applyDomainFilters(results, webSearchPlan) {
  const list = Array.isArray(results) ? results : [];
  const allowed = webSearchPlan?.allowedDomains;
  const blocked = webSearchPlan?.blockedDomains;

  if (!allowed?.length && !blocked?.length) return list;

  return list.filter((r) => {
    const host = hostOf(r?.url);
    if (!host) return false;
    if (blocked?.length && blocked.some((d) => matchesDomain(host, d))) return false;
    if (allowed?.length && !allowed.some((d) => matchesDomain(host, d))) return false;
    return true;
  });
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

function matchesDomain(host, domain) {
  const d = String(domain || "").toLowerCase().replace(/^\*\./, "").replace(/^https?:\/\//, "").split("/")[0];
  if (!d) return false;
  return host === d || host.endsWith(`.${d}`);
}