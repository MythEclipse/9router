/**
 * Web search — non-streaming attachment.
 *
 * The streaming twin lives in webSearchStream.js; this handles the whole-body
 * case (`"stream": false`). Same two lanes:
 *
 *  - passthrough: the upstream streamed the blocks itself and they are already in
 *    `responseBody.content` — add nothing.
 *  - bridge: find the model's `web_search` function call, run the search, and
 *    splice in the Anthropic `server_tool_use` + `web_search_tool_result` pair.
 *
 * The function call is REPLACED by the server-tool pair rather than left in
 * place: leaving a `tool_use` block whose result never arrives (the client does
 * not execute function tools for a server tool it was told about) leaves the
 * transcript dangling and Claude Code retries the turn forever.
 */

import {
	isClaudeCodeSearchTool,
	SERVER_TOOL_USE_BLOCK,
	WEB_SEARCH_RESULT_BLOCK,
	WEB_SEARCH_TOOL_NAME,
} from "../config/webSearchConstants.ts"
import { buildSearchBlocks, buildSearchErrorBlocks } from "./webSearchBridge.ts"
import { normalizeToolUseId } from "./webSearchStream.ts"

/** True when this assistant turn already carries upstream search output. */
export function hasUpstreamSearch(content) {
	return (
		Array.isArray(content) &&
		content.some((b) => b?.type === SERVER_TOOL_USE_BLOCK || b?.type === WEB_SEARCH_RESULT_BLOCK)
	)
}

/** Locate the model's `web_search` function call in an assistant turn. */
/**
 * Find the model's search call in an assistant turn.
 *
 * Matches BOTH shapes seen on the wire:
 *   - `name: "web_search"` — Anthropic's server tool (API clients).
 *   - `name: "WebSearch"` — Claude Code's own client tool.
 */
export function findWebSearchCall(content) {
	if (!Array.isArray(content)) return null
	return (
		content.find(
			(b) =>
				b?.type === "tool_use" &&
				(b?.name === WEB_SEARCH_TOOL_NAME || isClaudeCodeSearchTool({ name: b.name })),
		) || null
	)
}

/**
 * Run the pending search calls and splice the Anthropic block pair in.
 *
 * Mutates and returns `responseBody` — the pipeline reuses it downstream, and
 * returning the same object keeps the call site a one-liner.
 *
 * @param {object} params
 * @param {object} params.responseBody  parsed Claude response (mutated)
 * @param {object} params.webSearchPlan result of resolveWebSearchPlan
 * @param {Function} params.runSearch    async ({query, plan, toolUseId}) => SearchResult[]
 * @param {object} [params.log]
 * @returns {Promise<object>}
 */
export async function attachWebSearchToClaudeBody({ responseBody, webSearchPlan, runSearch, log }) {
	if (!webSearchPlan?.active || webSearchPlan.lane === "passthrough") return responseBody
	if (!responseBody || typeof responseBody !== "object") return responseBody

	const content = responseBody.content

	// Upstream already produced the blocks — never duplicate them.
	if (hasUpstreamSearch(content)) return responseBody

	const call = findWebSearchCall(content)
	if (!call) return responseBody

	const query = typeof call.input?.query === "string" ? call.input.query.trim() : ""
	// The model emitted a plain toolu_* id. Anthropic hard-rejects a
	// server_tool_use whose id is not srvtoolu_*, so the pair is emitted under a
	// normalized id — matching what the streaming path already does.
	const toolUseId = normalizeToolUseId(call.id)

	// Remove the function call first: its replacement is the server-tool pair, and
	// a tool_use with no matching result would hang the client.
	const index = content.indexOf(call)
	content.splice(index, 1)

	let blocks
	if (!query) {
		blocks = buildSearchErrorBlocks({
			query: "",
			toolUseId,
			errorCode: "query_too_long",
			message: "web_search call did not include a query",
		})
	} else {
		try {
			const results = await runSearch({
				query,
				plan: webSearchPlan,
				toolUseId,
				searchType: call?.searchType || call?.input?.search_type,
			})
			blocks = buildSearchBlocks({ query, toolUseId, results })
		} catch (error) {
			log?.warn?.("WEBSEARCH", `search failed: ${error?.message || error}`)
			blocks = buildSearchErrorBlocks({
				query,
				toolUseId,
				errorCode: "unavailable",
				message: error?.message || String(error),
			})
		}
	}

	// Splice back in place so citations stay next to the text that referenced them.
	content.splice(index, 0, blocks.serverToolUse, blocks.toolResult)

	// The upstream ended its turn with stop_reason "tool_use" because it had just
	// emitted that call. The bridge answered it with the native server-tool pair,
	// so no client tool is left pending, and Anthropic's own completed search ends
	// with "end_turn". Left as "tool_use" the turn advertises a tool result that
	// never arrives and the client rejects it. Any OTHER tool_use still in the
	// turn is genuinely pending, so stop_reason is only corrected when none are.
	if (responseBody.stop_reason === "tool_use" && !content.some((b) => b?.type === "tool_use")) {
		responseBody.stop_reason = "end_turn"
	}

	// A turn whose only content was the search call now has no text; give the
	// client an empty string rather than a missing `content` field.
	if (!responseBody.content || responseBody.content.length === 0) {
		responseBody.content = [{ type: "text", text: "" }]
	}

	return responseBody
}
