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
import { buildStreamWebSearchInjection } from "./webSearchStreamBuild.ts"
import { createWebSearchStreamState, observeWebSearchFrame } from "./webSearchStreamState.ts"
export function suppressSearchToolUseFrames(text, state) {
	const out = []

	for (const frame of text.split(/(?<=\n\n)/)) {
		if (!frame) continue
		const parsed = parseSseFrame(frame)
		if (!parsed) {
			out.push(frame)
			continue
		}

		if (parsed.type === "content_block_start" && isSearchToolUseBlock(parsed.content_block)) {
			// Remember the index so the delta/stop frames of this same block, which
			// may arrive in later chunks, are recognised as already suppressed.
			state.suppressedIndexes.add(parsed.index)
			continue
		}
		if (parsed.type === "message_stop") {
			// Held back: the search blocks must ride inside the turn, before it ends.
			state.sawMessageStop = true
			continue
		}
		if (parsed.type === "message_delta" && parsed.delta?.stop_reason) {
			// Also terminal — stop_reason ends the turn for a Claude client, so the
			// search blocks have to be injected ahead of it too.
			state.heldMessageDelta = frame
			continue
		}

		// Renumber content blocks so the client sees a contiguous 0..n sequence.
		// Dropping a block leaves a hole, and a Claude client rejects the stream when
		// block indices skip — the exact failure that surfaced as "The model's tool
		// call could not be parsed".
		if (parsed.type === "content_block_start" && typeof parsed.index === "number") {
			if (state.suppressedIndexes.has(parsed.index)) continue
			if (parsed.content_block?.type === "tool_use" && parsed.content_block.id) {
				state.survivingToolUseIds.add(parsed.content_block.id)
			}
			const mapped = state.indexMap.get(parsed.index) ?? state.nextBlockIndex
			state.indexMap.set(parsed.index, mapped)
			state.nextBlockIndex = Math.max(state.nextBlockIndex, mapped + 1)
			parsed.index = mapped
			out.push(renderFrame(frame, parsed))
			continue
		}
		if (
			(parsed.type === "content_block_delta" || parsed.type === "content_block_stop") &&
			typeof parsed.index === "number"
		) {
			if (state.suppressedIndexes.has(parsed.index)) continue
			const mapped = state.indexMap.get(parsed.index)
			if (mapped === undefined) {
				out.push(frame)
				continue
			}
			parsed.index = mapped
			out.push(renderFrame(frame, parsed))
			continue
		}

		out.push(frame)
	}
	return out.join("")
}

/**
 * Re-emit the held terminal message_delta with a stop_reason that matches what
 * the client is actually receiving.
 *
 * The upstream ends with `stop_reason: "tool_use"`, which was true of its own
 * stream — it had just emitted a tool call. The bridge answers that call with
 * Anthropic's native server-tool pair, so no client tool is left pending. Keeping
 * "tool_use" describes a turn whose tool_use never arrives, and Claude Code
 * rejects it with "The model's tool call could not be parsed". Anthropic's own
 * completed search ends the turn with `end_turn` (see the web-search response
 * docs), which is what the client sees here too.
 *
 * `stop_reason: "tool_use"` is kept when another client tool_use did survive,
 * because in that case the turn really is waiting on a tool result.
 */
export function rewriteStopReason(state) {
	const frame = state.heldMessageDelta || ""
	const parsed = parseSseFrame(frame)
	if (!parsed || parsed.type !== "message_delta") return frame
	if (state.survivingToolUseIds.size > 0) return frame

	if (parsed.delta?.stop_reason === "tool_use") {
		parsed.delta = { ...parsed.delta, stop_reason: "end_turn" }
	}
	return renderFrame(frame, parsed)
}

/** Re-serialise an SSE frame, preserving its `event:` line. */
export function renderFrame(frame, payload) {
	const data = `data: ${JSON.stringify(payload)}`
	if (/^event: /m.test(frame)) {
		const ev = frame.match(/^event: (\w+)/m)[1]
		return `event: ${ev}\n${data}\n\n`
	}
	return `${data}\n\n`
}

/** Parse one SSE frame's JSON payload, or null if it carries none. */
export function parseSseFrame(frame) {
	for (const line of frame.split("\n")) {
		if (!line.startsWith("data:")) continue
		const payload = line.slice(5).trim()
		if (!payload || payload === SSE_DONE) continue
		try {
			return JSON.parse(payload)
		} catch {
			return null
		}
	}
	return null
}

/** A translated `tool_use` block that is the search call the bridge answers. */
export function isSearchToolUseBlock(block) {
	if (!block || block.type !== "tool_use") return false
	return block.name === WEB_SEARCH_TOOL_NAME || isClaudeCodeSearchTool(block)
}
