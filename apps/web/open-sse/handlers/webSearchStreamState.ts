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
export function createWebSearchStreamState() {
	return {
		/** Every tool_use id seen, with the name the model called it under. */
		calls: [],
		/** Tool ids the UPSTREAM already answered (passthrough) — never re-run. */
		answeredByUpstream: new Set(),
		/** True once an upstream server_tool_use is observed. */
		sawUpstreamSearch: false,
		/** content_block index → tool_use id, so a later input delta finds its call. */
		byIndex: new Map(),
		/**
		 * OpenAI tool_calls slot (by `index`) → { id, name, args } under
		 * construction. An OpenAI-shaped upstream splits one call across chunks:
		 * id + name in the first, argument fragments in the rest. Accumulating here
		 * is what lets the query be reconstructed at all.
		 */
		openAiCalls: new Map(),
		/** content_block index → true once its tool_use start frame was suppressed. */
		suppressedIndexes: new Set(),
		/** Highest content_block index the client has seen; injected blocks continue after it. */
		nextBlockIndex: 0,
		/** Original content_block index → the contiguous index the client receives. */
		indexMap: new Map(),
		/** Ids of client tool_use blocks the client will actually receive. */
		survivingToolUseIds: new Set(),
		/**
		 * True once the upstream has sent message_stop. Injection must land BEFORE
		 * that frame: Claude Code closes the turn at message_stop and treats
		 * anything after it as unparseable, which surfaced as
		 * "The model's tool call could not be parsed".
		 */
		sawMessageStop: false,
		/** message_delta frame held back until the injected search results are sent. */
		heldMessageDelta: null as string | null,
	}
}

/**
 * Cheap gate: only frames that can carry search information are parsed.
 *
 * `input_json_delta` MUST be included. Anthropic streams a tool call's
 * arguments in a follow-up frame that mentions neither "tool_use" nor the search
 * block types — gating on those alone drops every argument delta, so the query
 * arrives empty and the call is wrongly errored as query-less.
 */
export function frameCanCarrySearch(frame) {
	return (
		frame.includes("tool_use") ||
		frame.includes("tool_calls") ||
		frame.includes(SERVER_TOOL_USE_BLOCK) ||
		frame.includes(WEB_SEARCH_RESULT_BLOCK) ||
		frame.includes("input_json_delta")
	)
}

/**
 * Observe one accumulated SSE frame. Parsing only — never rewriting — so a
 * malformed frame cannot corrupt what the client receives.
 */
export function observeWebSearchFrame(state, frame) {
	if (!state || !frame || !frameCanCarrySearch(frame)) return

	for (const line of frame.split("\n")) {
		if (!line.startsWith("data:")) continue
		const payload = line.slice(5).trim()
		if (!payload || payload === SSE_DONE) continue
		let json
		try {
			json = JSON.parse(payload)
		} catch {
			continue
		}

		visitBlocks(json, state)
		visitToolCallDeltas(json, state)
		mergeInputDelta(state, json)
	}
}

/**
 * Collect candidate blocks from a frame.
 *
 * Two shapes carry them:
 *   - streaming: `{ type: "content_block_start", content_block: {…} }`
 *   - whole-body / partial aggregation: `{ content: [{…}, …] }`
 * A `content_block_delta` carrying `input_json_delta` is what fills in a tool
 * call's arguments, so a start frame often has an empty `input` and the query
 * only arrives in a later delta — see note in observeWebSearchFrame.
 */
export function collectBlocks(json) {
	if (Array.isArray(json?.content)) return json.content
	if (json?.content_block && typeof json.content_block === "object") return [json.content_block]
	return []
}

/**
 * Walk OpenAI chat-completions `tool_calls` deltas.
 *
 * The bridge is wired around the provider response, NOT the client response, so
 * when the provider is OpenAI-shaped (antigravity, any OpenAI-compatible
 * upstream) the frames arriving here carry `choices[].delta.tool_calls`, not
 * Anthropic `content_block` events. Anthropic arrives only later, after
 * translation. Recognising only the Anthropic shape means the bridge silently
 * does nothing for every OpenAI-shaped provider — which is every provider most
 * Claude Code traffic actually uses.
 */
export function visitToolCallDeltas(json, state) {
	const deltas = json?.choices
	if (!Array.isArray(deltas)) return

	for (const choice of deltas) {
		const calls = choice?.delta?.tool_calls
		if (!Array.isArray(calls)) continue

		for (const call of calls) {
			// OpenAI splits a tool call across chunks: the first carries id + name,
			// later ones carry only `arguments` fragments. Accumulate by index so the
			// name learned in chunk 1 survives the fragments in chunks 2..n.
			const slot = call.index ?? 0
			let pending = state.openAiCalls.get(slot)
			if (!pending) {
				pending = { id: null, name: null, args: "" }
				state.openAiCalls.set(slot, pending)
			}
			if (call.id) pending.id = call.id
			if (call.function?.name) pending.name = call.function.name
			if (typeof call.function?.arguments === "string") {
				pending.args = (pending.args ?? "") + call.function.arguments
			}

			const isSearch =
				pending.name === WEB_SEARCH_TOOL_NAME || isClaudeCodeSearchTool({ name: pending.name })
			if (!isSearch || !pending.id) continue

			// Wait for the arguments to actually parse. The first chunk of an OpenAI
			// tool call carries `arguments: ""`, which parses to `{}` — recording on
			// that yields a call with an EMPTY query and the search is then rejected
			// as query_too_long. The call is only real once its JSON has an argument.
			let args
			try {
				args = JSON.parse(pending.args || "")
			} catch {
				continue
			}
			if (typeof args !== "object" || args === null || Array.isArray(args)) continue
			if (!args.query) continue

			record(state, pending.id, pending.name, args.query, choice.index, args.search_type)
			state.openAiCalls.delete(slot)
		}
	}
}

/** Walk every block container a Claude frame may use. */
export function visitBlocks(json, state) {
	const index = json?.index
	for (const block of collectBlocks(json)) {
		if (!block || typeof block !== "object") continue
		if (block.type === SERVER_TOOL_USE_BLOCK) {
			state.sawUpstreamSearch = true
			record(
				state,
				block.id,
				WEB_SEARCH_TOOL_NAME,
				block.input?.query,
				index,
				block.input?.search_type,
			)
		} else if (
			block.type === "tool_use" &&
			(block.name === WEB_SEARCH_TOOL_NAME || isClaudeCodeSearchTool(block))
		) {
			record(state, block.id, block.name, block.input?.query, index, block.input?.search_type)
		} else if (block.type === WEB_SEARCH_RESULT_BLOCK && block.tool_use_id) {
			// Upstream answered this one; re-running it would duplicate the results.
			state.answeredByUpstream.add(block.tool_use_id)
			// A result block is proof the upstream ran the search even when no
			// server_tool_use block was seen (some upstreams emit only the result).
			state.sawUpstreamSearch = true
		}
	}
}

/**
 * Merge a streamed `input_json_delta` into the pending call's input.
 *
 * Anthropic sends a tool call as content_block_start (empty input) followed by
 * one or more content_block_delta frames carrying `partial_json`. Without this
 * the query is never seen and the call would be errored as query-less.
 */
export function mergeInputDelta(state, json) {
	const partial = json?.delta?.partial_json
	if (typeof partial !== "string" || !partial) return
	const callId = json?.index != null ? state.byIndex.get(json.index) : null
	if (!callId) return
	const call = state.calls.find((c) => c.id === callId)
	if (!call) return
	call.rawInput = (call.rawInput || "") + partial
	try {
		const parsed = JSON.parse(call.rawInput)
		if (typeof parsed?.query === "string" && parsed.query.trim()) {
			call.query = parsed.query.trim()
		}
		if (typeof parsed?.search_type === "string" && parsed.search_type.trim()) {
			call.searchType = parsed.search_type.trim()
		}
	} catch {
		// Partial JSON mid-stream: wait for the next delta to complete it.
	}
}

export function record(state, id, name, query, index, _searchType) {
	if (!id) return
	if (index != null) state.byIndex.set(index, String(id))
	// The model called the bridge tool with a non-Anthropic id. The block we emit
	// must satisfy /^srvtoolu_/ for the client to accept the transcript, so the
	// pairing id is normalized here and reused for both blocks.
	if (state.calls.some((c) => c.id === String(id))) return
	state.calls.push({
		id: String(id),
		name,
		query: typeof query === "string" && query.trim() ? query.trim() : "",
		normalizedId: normalizeToolUseId(id),
	})
}

/** Coerce any id into Anthropic's required `srvtoolu_[A-Za-z0-9_]` shape. */
export function normalizeToolUseId(raw) {
	const id = String(raw ?? "")
	if (SERVER_TOOL_USE_ID_RE.test(id)) return id
	const cleaned = id.replace(/[^A-Za-z0-9_]/g, "_")
	return `srvtoolu_${cleaned || "9r"}`
}

/** Calls the model made that still need a result. */
export function pendingSearchCalls(state) {
	if (!state) return []
	return state.calls.filter((c) => !state.answeredByUpstream.has(c.id))
}

/** Serialize the Anthropic block pair into SSE frames. */
