/**
 * Anthropic web search protocol — request detection and lane planning.
 *
 * Claude Code pointed at a gateway declares Anthropic's server-side search tool
 * (`web_search_20250305`) and expects `server_tool_use` +
 * `web_search_tool_result` blocks back. Whether 9router can satisfy that
 * directly depends on where the request is routed:
 *
 *   passthrough — the upstream understands the tool itself. Forward it verbatim
 *                 and run nothing. This is the real Anthropic API and
 *                 Anthropic-compatible upstreams that declare support.
 *   bridge      — everything else. 9router strips the server tool, exposes a
 *                 regular function tool so the model can ask for a search,
 *                 runs it, and synthesizes the Anthropic blocks itself.
 *
 * The decision is made from the ROUTE (provider + capability registry), never
 * from the client — a client asking for search must not be able to pick the
 * lane.
 */

import { PROVIDERS } from "../config/providers.ts";
import {
  WEB_SEARCH_TOOL_NAME,
  CLAUDE_SUPPORTED_TOOL_TYPE_RE,
  isWebSearchTool,
  findClaudeCodeSearchTool,
  clampMaxUses,
  DEFAULT_MAX_RESULTS,
} from "../config/webSearchConstants.ts";

export const LANE_PASSTHROUGH = "passthrough";
export const LANE_BRIDGE = "bridge";
export const LANE_NONE = "none";

/** Locate the Anthropic web search tool in a request's `tools[]`. */
export function findWebSearchTool(body) {
  if (!body || !Array.isArray(body.tools)) return null;
  return body.tools.find(isWebSearchTool) || null;
}

/** True when this request declares Anthropic's server-side web search. */
export function hasWebSearchTool(body) {
  return !!findWebSearchTool(body);
}

/**
 * Does the upstream itself run Anthropic's web search tool?
 *
 * Only two cases are safe to forward:
 *   - the provider IS Anthropic;
 *   - an Anthropic-compatible upstream that explicitly whitelists `web_search_*`
 *     via `quirks.claudeSupportedToolTypes` (e.g. DeepSeek).
 *
 * Everything else drops the tool in formats/claude.js, which would silently
 * turn a search request into a no-op.
 */
export function upstreamRunsWebSearch(provider) {
  const cfg = PROVIDERS[provider];
  if (!cfg) return false;
  if (provider === "claude" || provider === "anthropic") return true;
  const supported = cfg.quirks?.claudeSupportedToolTypes;
  return Array.isArray(supported) && supported.some((t) => CLAUDE_SUPPORTED_TOOL_TYPE_RE.test(t));
}

/**
 * Resolve the search tool's declared options into a normalized plan.
 * Clamps every knob so a client cannot ask for an unbounded fan-out.
 */
/**
 * Read the tool declaration's limits and domain filters.
 *
 * Anthropic's server tool carries them at the top level (`max_uses`,
 * `allowed_domains`, ...). Claude Code's client tool declares them only as
 * *schema* — `{input_schema: {properties: {query, allowed_domains, ...}}}`, with
 * no values at all (the filters arrive per-call in the tool input). So both
 * places are read, and defaults apply when neither carries a value.
 */
function readToolOptions(tool) {
  const props = tool?.input_schema?.properties || {};
  const maxUses = clampMaxUses(tool?.max_uses ?? tool?.maxUses);
  const maxResults = Math.min(
    Math.max(1, Number(tool?.max_results) || DEFAULT_MAX_RESULTS),
    Number.MAX_SAFE_INTEGER,
  );
  const domains = (value) => (Array.isArray(value) ? value.filter(Boolean) : []);
  return {
    maxUses,
    defaultMaxResults: Math.min(maxResults, DEFAULT_MAX_RESULTS),
    allowedDomains: domains(tool?.allowed_domains ?? props.allowed_domains),
    blockedDomains: domains(tool?.blocked_domains ?? props.blocked_domains),
  };
}

/**
 /** Plan web search for a chat request.
  *
  * @returns {{active: boolean, lane: string, reason: string, tool: object|null,
  *            maxUses: number, defaultMaxResults: number,
  *            allowedDomains: string[], blockedDomains: string[]}}
  */
 export function resolveWebSearchPlan({ body, provider, settings = {} }: { body: Record<string, unknown>; provider: string; settings?: { webSearchEnabled?: boolean; searchProviderId?: string | null } }) {
  const inactive = { active: false, lane: LANE_NONE, reason: "not requested", tool: null };

  if (settings.webSearchEnabled === false) {
    return { ...inactive, reason: "disabled by settings" };
  }

  // Two shapes to support, both real on the wire:
  //   1. Anthropic's server tool (`type: "web_search_2025xxxx"`) — declared by
  //      API clients and by CC's own internal search sub-request.
  //   2. Claude Code's client tool `WebSearch` (no `type`) — CC executes it
  //      locally and returns an ordinary tool_result. Keying only off (1) is why
  //      CC's own searches came back empty: it never declares (1).
  const serverTool = findWebSearchTool(body);
  const clientTool = serverTool ? null : findClaudeCodeSearchTool(body?.tools);

  if (!serverTool && !clientTool) return { ...inactive, reason: "no web_search tool declared" };

  const tool = serverTool || clientTool;
  const options = readToolOptions(clientTool || serverTool);

  // A combo name ("search-combo-1") is not in AI_PROVIDERS, so it can never be
  // selected by provider-id resolution. Carry it explicitly: the bridge must
  // target the same thing the operator configured for /v1/search.
  const searchTargetModel = settings.searchProviderId || null;

  // Claude Code's client tool is always executed by us: there is no upstream
  // server tool to forward, so passthrough would silently return nothing.
  const lane = (!clientTool && upstreamRunsWebSearch(provider))
    ? LANE_PASSTHROUGH
    : LANE_BRIDGE;

  return {
    active: true,
    lane,
    reason: clientTool
      ? "Claude Code client WebSearch, bridged"
      : lane === LANE_PASSTHROUGH
        ? "upstream runs web search"
        : "9router bridges web search",
    tool,
    isClaudeCodeClientTool: !!clientTool,
    searchTargetModel,
    ...options,
  };
}

/**
 * Strip the server tool from `tools[]` and install the function-tool bridge the
 * model will actually call. Mutates in place (the pipeline reuses the body),
 * and is a no-op on the passthrough lane.
 *
 * The function tool advertises itself as the same `web_search` name so the
 * model's emitted call is name-compatible with the server tool it was told
 * about; the response translator then rewrites that call back into a
 * `server_tool_use` block.
 */
export function installBridgeTool(body, plan, targetFormat = "openai") {
  if (!plan?.active || plan.lane !== LANE_BRIDGE) return false;

  // Claude Code's client tool is already a callable function declaration the
  // model can use as-is. Replacing it with our bridge declaration would drop
  // allowed_domains/blocked_domains from its schema and rewrite its name.
  if (plan.isClaudeCodeClientTool) return true;

  const others = (body.tools || []).filter((t) => !isWebSearchTool(t));
  const [bridgeTool] = createBridgeToolDefinition(plan, targetFormat);

  body.tools = [...others, bridgeTool];

  // tool_choice may name the server tool by type; a bare function tool_choice
  // would now point at a tool that no longer exists.
  const tc = body.tool_choice;
  if (tc && typeof tc === "object" && isWebSearchTool(tc)) {
    body.tool_choice = { type: "tool", name: WEB_SEARCH_TOOL_NAME };
  }
  return true;
}

/** True when `format` is one of the Anthropic-family wire formats. */
export function isClaudeTargetFormat(format) {
  const f = String(format || "").toLowerCase();
  return f === "claude" || f === "anthropic";
}

const BRIDGE_DESCRIPTION =
  "Search the public web and return ranked results. Call this when the answer " +
  "depends on current information, documentation, or facts you cannot verify from " +
  "the conversation. Returns titles, URLs, and snippets.";

/** Anthropic-shaped input_schema, shared by the claude bridge declaration. */
function bridgeInputSchema() {
  return {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query." },
      search_type: {
        type: "string",
        enum: ["web", "news"],
        description: "web = general results, news = recent news articles.",
      },
    },
    required: ["query"],
  };
}

/**
 * The client-facing tool definition 9router exposes in place of the server tool.
 *
 * The shape MUST match the format the body is already in: `translatedBody` is in
 * the provider's format, so an Anthropic-shaped provider needs Anthropic's
 * `{type, name, input_schema}` and not OpenAI's `{type: "function", function}`.
 * Emitting the wrong one makes the upstream reject the request outright.
 */
export function createBridgeToolDefinition(plan, targetFormat = "openai") {
  if (isClaudeTargetFormat(targetFormat)) {
    return [{
      type: WEB_SEARCH_TOOL_NAME,
      name: WEB_SEARCH_TOOL_NAME,
      description: BRIDGE_DESCRIPTION,
      input_schema: bridgeInputSchema(),
    }];
  }
  return [{
    type: "function",
    function: {
      name: WEB_SEARCH_TOOL_NAME,
      description: BRIDGE_DESCRIPTION,
      parameters: bridgeInputSchema(),
    },
  }];
}