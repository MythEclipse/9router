/**
 * Web search — streaming injection of Anthropic's block pair.
 *
 * Two situations produce the blocks:
 *
 *  1. **passthrough lane** — the upstream ran the search itself and already
 *     streamed `server_tool_use` + `web_search_tool_result`. 9router must add
 *     nothing and rewrite nothing.
 *  2. **bridge lane** — the model called the `web_search` function tool. 9router
 *     runs the search at end-of-stream and appends the Anthropic block pair,
 *     pairing them to the model's own tool_use id so the client's transcript
 *     stays consistent.
 *
 * Injection happens in the final `message_delta`, mirroring the safeguards
 * verdict, because that frame is the one Anthropic's own web-search output rides
 * on and the client parses results there.
 */

import {
	isClaudeCodeSearchTool,
	RESULT_ERROR_QUERY_TOO_LONG,
	RESULT_ERROR_UNAVAILABLE,
	SERVER_TOOL_USE_BLOCK,
	SERVER_TOOL_USE_ID_RE,
	WEB_SEARCH_RESULT_BLOCK,
	WEB_SEARCH_TOOL_NAME,
} from "../config/webSearchConstants.ts"
import { SSE_DONE } from "../utils/sseConstants.ts"
import {
	buildSearchBlocks,
	buildSearchErrorBlocks,
	searchFailureNotice,
} from "./webSearchBridge.ts"
import { normalizeToolUseId, pendingSearchCalls } from "./webSearchStreamState.ts"
export function buildBlocksSse(serverToolUse, toolResult, startIndex = 0) {
	// Anthropic's stream protocol numbers content blocks strictly increasing from
	// 0 and opens/closes each one on its own index. Hardcoding 0 made every
	// injected block collide with the blocks already on the wire, and Claude Code
	// rejected the whole turn with "The model's tool call could not be parsed".
	let i = startIndex
	const frames = [
		`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: i, content_block: { type: "text", text: "" } })}\n\n`,
		`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: i, delta: { type: "text_delta", text: "" } })}\n\n`,
		`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: i })}\n\n`,
	]
	i += 1

	frames.push(
		`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: i, content_block: serverToolUse })}\n\n`,
		`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(serverToolUse.input) } })}\n\n`,
		`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: i })}\n\n`,
	)
	i += 1

	frames.push(
		`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: i, content_block: toolResult })}\n\n`,
		`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: i })}\n\n`,
	)
	return frames.join("")
}

/**
 * Run every pending search and build the trailing SSE to append.
 *
 * @returns {Promise<string>} SSE text to append before the final message_delta,
 *   or "" when there is nothing to add.
 */
export async function buildStreamWebSearchInjection({ webSearchPlan, state, log, runSearch }) {
	if (!webSearchPlan?.active || !state) return ""

	// Upstream already produced the blocks; adding ours would duplicate them.
	if (state.sawUpstreamSearch) return ""

	const pending = pendingSearchCalls(state)
	if (pending.length === 0) return ""

	const chunks = []
	for (const call of pending.slice(0, webSearchPlan.maxUses)) {
		// A call with no query cannot be executed; Anthropic's own behaviour is to
		// answer it with an error block rather than leave the tool hanging.
		if (!call.query) {
			log?.warn?.("WEBSEARCH", "web_search call carried no query; emitting error block")
			const { serverToolUse, toolResult } = buildSearchErrorBlocks({
				query: "",
				toolUseId: call.normalizedId,
				errorCode: RESULT_ERROR_QUERY_TOO_LONG,
				message: "web_search call did not include a query",
			})
			chunks.push(buildBlocksSse(serverToolUse, toolResult, state.nextBlockIndex))
			state.nextBlockIndex += 3
			continue
		}
		const query = call.query

		try {
			const results = await runSearch({
				query,
				plan: webSearchPlan,
				toolUseId: call.normalizedId,
				searchType: call.searchType,
			})
			const { serverToolUse, toolResult } = buildSearchBlocks({
				query,
				toolUseId: call.normalizedId,
				results,
			})
			chunks.push(buildBlocksSse(serverToolUse, toolResult, state.nextBlockIndex))
			state.nextBlockIndex += 3
		} catch (error) {
			// Fail-safe: surface the failure in Anthropic's own vocabulary rather
			// than silently dropping the call — a missing tool_result leaves the
			// client waiting on a tool that will never complete.
			log?.warn?.("WEBSEARCH", `search failed: ${error?.message || error}`)
			const { serverToolUse, toolResult } = buildSearchErrorBlocks({
				query,
				toolUseId: call.normalizedId,
				errorCode: RESULT_ERROR_UNAVAILABLE,
				message: error?.message || String(error),
			})
			chunks.push(buildBlocksSse(serverToolUse, toolResult, state.nextBlockIndex))
			state.nextBlockIndex += 3
			chunks.push(
				`data: ${JSON.stringify({ type: "text_delta", text: searchFailureNotice(error?.message) })}\n\n`,
			)
		}
	}

	return chunks.join("")
}

/**
 * Wrap a byte stream so search calls are observed, then append the block pair
 * once the upstream stream ends.
 *
 * Byte-level tee: every chunk is forwarded unchanged; parsing is observation
 * only, so a parse failure cannot corrupt the response.
 */
/**
 * Remove the model's own search tool_use frames from a chunk on the bridge lane.
 *
 * The bridge answers a search call with Anthropic's NATIVE server-tool pair
 * (`server_tool_use` + `web_search_tool_result`). The model's original
 * `tool_use` for that call must therefore not reach the client: Claude Code
 * executes a client `tool_use` itself, locally, and reports "Did 0 searches"
 * while ignoring the native pair that was already emitted for the same call.
 * The non-streaming path has always spliced the original call out for the same
 * reason — this brings the streaming path in line with it.
 *
 * Only search tool_use blocks are dropped; every other tool_use (Read, Bash,
 * …) is forwarded byte-for-byte so multi-tool turns keep working.
 */

/**
 * Drop the model's own search `tool_use` from an already-translated Claude
 * stream, so the client never sees a call the bridge has already answered.
 *
 * The injector wraps the client's-format stream, so by the time a frame reaches
 * here the upstream `tool_calls` delta has already been translated into
 * Anthropic's `content_block_start` / `content_block_delta*` /
 * `content_block_stop` triple keyed by `index`. The whole triple must be
 * suppressed together: dropping only the start frame would leave orphaned
 * deltas and a stop frame for a block that never opened.
 *
 * Only search calls are touched. Every other tool_use is forwarded byte-for-byte,
 * so a turn calling WebSearch alongside Read/Bash still delivers those.
 */
