/**
 * Claude Code CCR worker routes — POST /v1/code/sessions/[id]/worker/<route>
 *
 * Claude Code's OWN `WebSearch` client tool does not go through the Anthropic
 * Messages tool-call protocol at all. Reading the installed 2.1.296 binary, its
 * two paths are:
 *
 *   - gateway path: POST {base}/v1/code/sessions/{ccrSessionId}/worker/web-search
 *     expecting { results: [{ title, url, snippet? }] }
 *   - local path (the default): synthesises the string
 *     `Web search results for query: "…"` plus the "REMINDER: You MUST include the
 *     sources above" suffix, with ZERO results — which is the "Did 0 searches" /
 *     empty-placeholder behaviour users report.
 *
 * The gateway path is gated behind CLAUDE_CODE_WEBSEARCH_USE_CCR_PROXY *and* a
 * CCR session id. Without both, the local stub always wins. So serving this route
 * is what makes Claude Code's WebSearch actually work against 9router.
 *
 * The response shape here is deliberately NOT the Anthropic
 * `server_tool_use`/`web_search_tool_result` pair — that belongs to the Anthropic
 * server-tool lane (see open-sse/handlers/webSearch*) and is a different protocol.
 * This route answers Claude Code's own worker contract.
 */
import { handleSearch } from "@/sse/handlers/search";
import { getProviderConnections } from "@/lib/db/repos/connectionsRepo";
import { getSettings } from "@/lib/localDb";
import { resolveSearchProvider } from "open-sse/handlers/webSearchCredentials";

export const dynamic = "force-dynamic";

/** Routes this worker exposes. Anything else is a 404. */
const WORKERS = new Set(["web-search"]);

/**
 * Error envelope matching Claude Code's worker contract.
 *
 * The client parses the 200 body with a schema of
 *   { results?: [{title?, url?, snippet?}], error?: {error_type, error_message} | null }
 * and reports `data.error.error_type` / `data.error.error_message`. Using the
 * API-wide `{error:{type,message}}` shape instead makes both fields undefined,
 * so a real failure surfaces to the user as an empty message.
 */
function errorResponse(status, errorType, message) {
  return jsonResponse({ error: { error_type: errorType, error_message: message } }, status);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Pick the search target the same way the bridge does.
 *
 * resolveSearchProvider already encodes the two rules that matter here:
 * an operator-pinned provider wins, and otherwise a connected DEDICATED engine
 * is preferred over the request's chat provider. Choosing by candidate order
 * instead picked `antigravity` (Vertex grounding redirects — result URLs that
 * resolve nowhere useful) for a claude-opus-5-5 request.
 *
 * A combo name (e.g. "search-combo-1") is not in AI_PROVIDERS, so
 * resolveSearchProvider cannot validate it; that case is passed straight through
 * to handleSearch, which owns combo expansion.
 */
async function resolveSearchTarget() {
  const settings = await getSettings();
  const pinned = settings.webSearchProvider;
  const trimmedPinned = typeof pinned === "string" ? pinned.trim() : "";
  if (trimmedPinned) return trimmedPinned;

  const connections = await getProviderConnections({ isActive: true });
  const candidates = [...new Set(connections.map(({ provider }) => provider))];
  const resolved = resolveSearchProvider({ providerId: null, requestProvider: null, candidates });
  return resolved.providerId || null;
}

/**
 * Map 9router's unified result to Claude Code's `{title, url, snippet?}`.
 *
 * `snippet` matters: with CLAUDE_CODE_WEBSEARCH_CITATIONS set, Claude Code builds
 * the model's tool_result text from `content[].snippet` and drops results that
 * have none, so a missing snippet silently loses the citation entirely.
 */
function toWorkerResult(result: { title?: string; url: string; snippet?: string; content?: string } | null) {
  if (!result) return null;
  const url = typeof result.url === "string" ? result.url : "";
  if (!url) return null;
  const item: { title: string; url: string; snippet?: string } = {
    title: String(result.title || url),
    url,
  };
  const snippet = result.snippet || result.content || "";
  if (snippet) item.snippet = String(snippet);
  return item;
}

/**
 * POST /v1/code/sessions/[id]/worker/web-search
 *
 * Request  `{ query, allowed_domains?, blocked_domains?, search_profile? }`
 * Response `{ results?: [{ title?, url?, snippet? }], error?: {error_type, error_message} }`
 *
 * Note `search_profile`, not `max_uses`: the client's own search_subrequest uses
 * `max_uses`, but the worker route sends a profile name ("standard"|"extended"),
 * which only reaches here on the CCR-proxy lane. So the result cap is derived
 * from the profile rather than read from a `max_uses` field that never arrives.
 */
export async function POST(request, { params }) {
  const { id, worker } = await params;
  if (!WORKERS.has(worker)) {
    return errorResponse(404, "not_found", `unknown worker: ${worker}`);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "invalid_request", "Invalid JSON body");
  }

  const query = typeof body?.query === "string" ? body.query.trim() : "";
  if (!query) {
    return errorResponse(400, "invalid_request", "query is required");
  }

  // "extended" is the client's default; it buys a deeper result set.
  const maxResults = body?.search_profile === "standard" ? 5 : 10;

  const target = await resolveSearchTarget();
  if (!target) {
    return errorResponse(503, "no_search_provider", "no connected web search provider");
  }

  // Reuse the one supported search path so combo expansion, per-key access and
  // combo fallback all behave exactly as they do for a direct /v1/search call.
  const searchBody = {
    model: target,
    query,
    max_results: maxResults,
    ...(Array.isArray(body.allowed_domains) && body.allowed_domains.length
      ? { allowed_domains: body.allowed_domains }
      : {}),
    ...(Array.isArray(body.blocked_domains) && body.blocked_domains.length
      ? { blocked_domains: body.blocked_domains }
      : {}),
  };

  let payload;
  try {
    const inner = new Request("http://local/v1/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(request.headers.get("authorization")
          ? { authorization: request.headers.get("authorization") }
          : {}),
      },
      body: JSON.stringify(searchBody),
    });
    const res = await handleSearch(inner);
    payload = await res.json();
  } catch (error) {
    return errorResponse(502, "search_failed", error?.message || "search failed");
  }

  if (!payload || payload.error) {
    const message = payload?.error?.message || payload?.error || "search failed";
    return errorResponse(502, "search_failed", String(message));
  }

  const results = (payload.results || [])
    .map(toWorkerResult)
    .filter(Boolean);

  return jsonResponse({ results });
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}