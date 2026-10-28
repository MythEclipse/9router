/**
 * Anthropic server-side web search protocol constants.
 *
 * Wire shapes extracted from the installed Claude Code client (v2.1.296)
 * rather than documentation, for the same reason as safeguardsConstants.js:
 * Claude Code is what drives this contract, and a gateway that guesses the
 * shapes silently breaks citations.
 *
 * The contract is a pair that must travel together:
 *   request  : `tools: [{ type: "web_search_20250305", name: "web_search", … }]`
 *   response : a `server_tool_use` block immediately followed by the
 *              `web_search_tool_result` block that pairs to it by
 *              `tool_use_id`.
 *
 * Nothing here is Anthropic-specific in spirit — `server_tool_use` is the
 * generic server-tool envelope — but the tool type string and result block
 * shape are exactly what Claude Code parses.
 */

// The only search tool version Claude Code emits. Send this verbatim: a
// different date makes the client ignore the tool (and never call it).
export const WEB_SEARCH_TOOL_TYPE = "web_search_20250305"

// The tool name paired with the type above, and the name the model "calls".
export const WEB_SEARCH_TOOL_NAME = "web_search"

// Block types. Re-exported by the schema for consistency; declared here to keep
// the protocol pair in one file.
export const SERVER_TOOL_USE_BLOCK = "server_tool_use"
export const WEB_SEARCH_RESULT_BLOCK = "web_search_tool_result"
export const WEB_SEARCH_RESULT_ITEM = "web_search_result"

// Anthropic validates server tool ids against this pattern and hard-rejects the
// request otherwise (mirrors the check formats/claude.js already performs on
// inbound history).
export const SERVER_TOOL_USE_ID_PREFIX = "srvtoolu_"
export const SERVER_TOOL_USE_ID_RE = /^srvtoolu_[a-zA-Z0-9_]+$/

/**
 * Prefix for ids 9router synthesizes. The client only requires the
 * `srvtoolu_` prefix + [A-Za-z0-9_]; the extra segment makes our origin
 * obvious in logs and lets a reviewer spot a bridged result at a glance.
 */
export const SYNTHETIC_TOOL_USE_ID_PREFIX = "srvtoolu_9r_"

// Result `content` item keys Claude Code reads for citations.
export const RESULT_ITEM_KEYS = Object.freeze({
	TITLE: "title",
	URL: "url",
	PAGE_AGE: "page_age",
	ENCRYPTED_CONTENT: "encrypted_content",
})

// `error_code` values Anthropic uses inside web_search_tool_result when the
// search itself failed. The client surfaces these verbatim to the user, so they
// must not be invented: only ever emit one that actually happened.
export const RESULT_ERROR_MAX_USES = "max_uses_exceeded"
export const RESULT_ERROR_TOO_MANY = "too_many_requests"
export const RESULT_ERROR_QUERY_TOO_LONG = "query_too_long"
export const RESULT_ERROR_UNAVAILABLE = "unavailable"

/** Default number of results a bridged search requests. */
export const DEFAULT_MAX_RESULTS = 5

/** Cap so a single search cannot flood the context or the stream. */
export const MAX_RESULTS_CEILING = 20

/** Hard ceiling on searches per request (client-declared `max_uses`). */
export const MAX_USES_CEILING = 10

/** Tool-name prefix for the function-tool bridge (see webSearchBridge.js). */
export const BRIDGE_TOOL_NAME = "web_search"

/** Anthropic tool types an Anthropic-compatible upstream may declare support
 *  for via `quirks.claudeSupportedToolTypes`. Used to decide the passthrough
 *  lane — guessing here sends `web_search_*` to an upstream that will 400. */
export const CLAUDE_SUPPORTED_TOOL_TYPE_RE = /^web_search_/

/**
 * The tool declaration Claude Code sends, rebuilt from a detected one.
 * Unknown keys are preserved so a future tool version's extra parameters
 * (e.g. a new filter) survive the round trip.
 */
export function isWebSearchToolType(type) {
	return typeof type === "string" && CLAUDE_SUPPORTED_TOOL_TYPE_RE.test(type)
}

/** True when this tool entry is Anthropic's server-side web search tool. */
export function isWebSearchTool(tool) {
	return isWebSearchToolType(tool?.type) && tool?.name === WEB_SEARCH_TOOL_NAME
}

/**
 * Claude Code's OWN client-side search tool.
 *
 * Distinct from `web_search`: Claude Code declares `WebSearch` as a plain
 * client tool (no `type`) carrying query/allowed_domains/blocked_domains, then
 * executes it locally and returns an ordinary `tool_result` — it never declares
 * Anthropic's `web_search_2025xxxx` server tool. Verified against a live
 * Claude Code 2.1.296 request captured on the wire.
 *
 * Recognising it is what lets 9router answer the call with real results instead
 * of leaving an empty tool_result that the model renders as a stub.
 */
export const CLAUDE_CODE_SEARCH_TOOL_NAME = "WebSearch"

export function isClaudeCodeSearchTool(tool) {
	if (!tool || typeof tool !== "object") return false
	// A server tool is handled by the other path. A stream block always has
	// `type: "tool_use"`, so that value must NOT disqualify the match — only a
	// `web_search_*` server-tool type does. Requiring a falsy `type` meant a
	// streamed WebSearch block was never recognised, which is the shape every
	// Claude Code search actually arrives in.
	if (typeof tool.type === "string" && /^web_search_/.test(tool.type)) return false
	return tool.name === CLAUDE_CODE_SEARCH_TOOL_NAME
}

/** Locate Claude Code's client-side WebSearch tool in a request's `tools[]`. */
export function findClaudeCodeSearchTool(tools) {
	if (!Array.isArray(tools)) return null
	return tools.find(isClaudeCodeSearchTool) || null
}

/** Anthropic only accepts these values; anything else is coerced down. */
export function clampMaxUses(value) {
	const n = Number(value)
	if (!Number.isFinite(n) || n <= 0) return 1
	return Math.min(Math.floor(n), MAX_USES_CEILING)
}
