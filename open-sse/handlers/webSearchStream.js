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
  WEB_SEARCH_TOOL_NAME,
  SERVER_TOOL_USE_ID_RE,
  WEB_SEARCH_RESULT_BLOCK,
  SERVER_TOOL_USE_BLOCK,
  RESULT_ERROR_QUERY_TOO_LONG,
  RESULT_ERROR_UNAVAILABLE,
} from "../config/webSearchConstants.js";
import { buildSearchBlocks, buildSearchErrorBlocks, searchFailureNotice } from "./webSearchBridge.js";
import { SSE_DONE } from "../utils/sseConstants.js";

/** Mutable state accumulated while the upstream stream is observed. */
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
  };
}

/**
 * Cheap gate: only frames that can carry search information are parsed.
 *
 * `input_json_delta` MUST be included. Anthropic streams a tool call's
 * arguments in a follow-up frame that mentions neither "tool_use" nor the search
 * block types — gating on those alone drops every argument delta, so the query
 * arrives empty and the call is wrongly errored as query-less.
 */
function frameCanCarrySearch(frame) {
  return frame.includes("tool_use")
    || frame.includes(SERVER_TOOL_USE_BLOCK)
    || frame.includes(WEB_SEARCH_RESULT_BLOCK)
    || frame.includes("input_json_delta");
}

/**
 * Observe one accumulated SSE frame. Parsing only — never rewriting — so a
 * malformed frame cannot corrupt what the client receives.
 */
export function observeWebSearchFrame(state, frame) {
  if (!state || !frame || !frameCanCarrySearch(frame)) return;

  for (const line of frame.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === SSE_DONE) continue;
    let json;
    try { json = JSON.parse(payload); } catch { continue; }

    visitBlocks(json, state);
    mergeInputDelta(state, json);
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
function collectBlocks(json) {
  if (Array.isArray(json?.content)) return json.content;
  if (json?.content_block && typeof json.content_block === "object") return [json.content_block];
  return [];
}

/** Walk every block container a Claude frame may use. */
function visitBlocks(json, state) {
  const index = json?.index;
  for (const block of collectBlocks(json)) {
    if (!block || typeof block !== "object") continue;
    if (block.type === SERVER_TOOL_USE_BLOCK) {
      state.sawUpstreamSearch = true;
      record(state, block.id, WEB_SEARCH_TOOL_NAME, block.input?.query, index, block.input?.search_type);
    } else if (block.type === "tool_use" && block.name === WEB_SEARCH_TOOL_NAME) {
      record(state, block.id, block.name, block.input?.query, index, block.input?.search_type);
    } else if (block.type === WEB_SEARCH_RESULT_BLOCK && block.tool_use_id) {
      // Upstream answered this one; re-running it would duplicate the results.
      state.answeredByUpstream.add(block.tool_use_id);
      // A result block is proof the upstream ran the search even when no
      // server_tool_use block was seen (some upstreams emit only the result).
      state.sawUpstreamSearch = true;
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
function mergeInputDelta(state, json) {
  const partial = json?.delta?.partial_json;
  if (typeof partial !== "string" || !partial) return;
  const callId = json?.index != null ? state.byIndex.get(json.index) : null;
  if (!callId) return;
  const call = state.calls.find((c) => c.id === callId);
  if (!call) return;
  call.rawInput = (call.rawInput || "") + partial;
  try {
    const parsed = JSON.parse(call.rawInput);
    if (typeof parsed?.query === "string" && parsed.query.trim()) {
      call.query = parsed.query.trim();
    }
    if (typeof parsed?.search_type === "string" && parsed.search_type.trim()) {
      call.searchType = parsed.search_type.trim();
    }
  } catch {
    // Partial JSON mid-stream: wait for the next delta to complete it.
  }
}

function record(state, id, name, query, index, searchType) {
  if (!id) return;
  if (index != null) state.byIndex.set(index, String(id));
  // The model called the bridge tool with a non-Anthropic id. The block we emit
  // must satisfy /^srvtoolu_/ for the client to accept the transcript, so the
  // pairing id is normalized here and reused for both blocks.
  if (state.calls.some((c) => c.id === String(id))) return;
  state.calls.push({
    id: String(id),
    name,
    query: typeof query === "string" && query.trim() ? query.trim() : "",
    normalizedId: normalizeToolUseId(id),
  });
}

/** Coerce any id into Anthropic's required `srvtoolu_[A-Za-z0-9_]` shape. */
export function normalizeToolUseId(raw) {
  const id = String(raw ?? "");
  if (SERVER_TOOL_USE_ID_RE.test(id)) return id;
  const cleaned = id.replace(/[^A-Za-z0-9_]/g, "_");
  return `srvtoolu_${cleaned || "9r"}`;
}

/** Calls the model made that still need a result. */
export function pendingSearchCalls(state) {
  if (!state) return [];
  return state.calls.filter((c) => !state.answeredByUpstream.has(c.id));
}

/** Serialize the Anthropic block pair into SSE frames. */
function buildBlocksSse(serverToolUse, toolResult) {
  const frames = [
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
    `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: serverToolUse })}\n\n`,
    `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(serverToolUse.input) } })}\n\n`,
    `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
    `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: toolResult })}\n\n`,
    `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
  ];
  return frames.join("");
}

/**
 * Run every pending search and build the trailing SSE to append.
 *
 * @returns {Promise<string>} SSE text to append before the final message_delta,
 *   or "" when there is nothing to add.
 */
export async function buildStreamWebSearchInjection({ webSearchPlan, state, log, runSearch }) {
  if (!webSearchPlan?.active || !state) return "";

  // Upstream already produced the blocks; adding ours would duplicate them.
  if (state.sawUpstreamSearch) return "";

  const pending = pendingSearchCalls(state);
  if (pending.length === 0) return "";

  const chunks = [];
  for (const call of pending.slice(0, webSearchPlan.maxUses)) {
    // A call with no query cannot be executed; Anthropic's own behaviour is to
    // answer it with an error block rather than leave the tool hanging.
    if (!call.query) {
      log?.warn?.("WEBSEARCH", "web_search call carried no query; emitting error block");
      const { serverToolUse, toolResult } = buildSearchErrorBlocks({
        query: "",
        toolUseId: call.normalizedId,
        errorCode: RESULT_ERROR_QUERY_TOO_LONG,
        message: "web_search call did not include a query",
      });
      chunks.push(buildBlocksSse(serverToolUse, toolResult));
      continue;
    }
    const query = call.query;

    try {
      const results = await runSearch({
        query, plan: webSearchPlan, toolUseId: call.normalizedId, searchType: call.searchType,
      });
      const { serverToolUse, toolResult } = buildSearchBlocks({
        query,
        toolUseId: call.normalizedId,
        results,
      });
      chunks.push(buildBlocksSse(serverToolUse, toolResult));
    } catch (error) {
      // Fail-safe: surface the failure in Anthropic's own vocabulary rather
      // than silently dropping the call — a missing tool_result leaves the
      // client waiting on a tool that will never complete.
      log?.warn?.("WEBSEARCH", `search failed: ${error?.message || error}`);
      const { serverToolUse, toolResult } = buildSearchErrorBlocks({
        query,
        toolUseId: call.normalizedId,
        errorCode: RESULT_ERROR_UNAVAILABLE,
        message: error?.message || String(error),
      });
      chunks.push(buildBlocksSse(serverToolUse, toolResult));
      chunks.push(`data: ${JSON.stringify({ type: "text_delta", text: searchFailureNotice(error?.message) })}\n\n`);
    }
  }

  return chunks.join("");
}

/**
 * Wrap a byte stream so search calls are observed, then append the block pair
 * once the upstream stream ends.
 *
 * Byte-level tee: every chunk is forwarded unchanged; parsing is observation
 * only, so a parse failure cannot corrupt the response.
 */
export function injectWebSearchIntoStream({ stream, webSearchPlan, log, runSearch, terminate }) {
  if (!webSearchPlan?.active || webSearchPlan.lane === "passthrough") return stream;

  const state = createWebSearchStreamState();
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";
  let doneReading = false;

  const observe = (text, final = false) => {
    buffer += text;
    const frames = buffer.split("\n\n");
    const tail = final ? "" : (frames.pop() || "");
    for (const frame of [...frames, tail]) {
      if (!frame) continue;
      observeWebSearchFrame(state, frame);
    }
    buffer = final ? "" : tail;
  };

  return new ReadableStream({
    async pull(controller) {
      if (doneReading) return;
      let result;
      try {
        result = await reader.read();
      } catch (error) {
        doneReading = true;
        try { reader.releaseLock(); } catch { /* already released */ }
        controller.error(error);
        return;
      }

      if (result.done) {
        doneReading = true;
        try { observe(decoder.decode(), true); } catch { /* ignore */ }
        try { reader.releaseLock(); } catch { /* already released */ }

        const injection = await buildStreamWebSearchInjection({ webSearchPlan, state, log, runSearch });
        if (injection) {
          try { controller.enqueue(new TextEncoder().encode(injection)); } catch { /* client gone */ }
        }
        try { terminate?.(); } catch { /* ignore */ }
        try { controller.close(); } catch { /* ignore */ }
        return;
      }

      // Forward the upstream chunk untouched, observing as it passes.
      controller.enqueue(result.value);
      try { observe(decoder.decode(result.value, { stream: true })); } catch { /* ignore */ }
    },
    cancel(reason) {
      doneReading = true;
      try { reader.cancel(reason); } catch { /* ignore */ }
    },
  });
}