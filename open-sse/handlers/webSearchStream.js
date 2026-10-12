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
  isClaudeCodeSearchTool,
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
    /**
     * OpenAI tool_calls slot (by `index`) → { id, name, args } under
     * construction. An OpenAI-shaped upstream splits one call across chunks:
     * id + name in the first, argument fragments in the rest. Accumulating here
     * is what lets the query be reconstructed at all.
     */
    openAiCalls: new Map(),
    /** content_block index → true once its tool_use start frame was suppressed. */
    suppressedIndexes: new Set(),
    /** Highest content_block index seen upstream; injected blocks continue after it. */
    nextBlockIndex: 0,
    /**
     * True once the upstream has sent message_stop. Injection must land BEFORE
     * that frame: Claude Code closes the turn at message_stop and treats
     * anything after it as unparseable, which surfaced as
     * "The model's tool call could not be parsed".
     */
    sawMessageStop: false,
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
    || frame.includes("tool_calls")
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
    visitToolCallDeltas(json, state);
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
function visitToolCallDeltas(json, state) {
  const deltas = json?.choices;
  if (!Array.isArray(deltas)) return;

  for (const choice of deltas) {
    const calls = choice?.delta?.tool_calls;
    if (!Array.isArray(calls)) continue;

    for (const call of calls) {
      // OpenAI splits a tool call across chunks: the first carries id + name,
      // later ones carry only `arguments` fragments. Accumulate by index so the
      // name learned in chunk 1 survives the fragments in chunks 2..n.
      const slot = call.index ?? 0;
      let pending = state.openAiCalls.get(slot);
      if (!pending) {
        pending = { id: null, name: null, args: "" };
        state.openAiCalls.set(slot, pending);
      }
      if (call.id) pending.id = call.id;
      if (call.function?.name) pending.name = call.function.name;
      if (typeof call.function?.arguments === "string") {
        pending.args = (pending.args ?? "") + call.function.arguments;
      }

      const isSearch = pending.name === WEB_SEARCH_TOOL_NAME || isClaudeCodeSearchTool({ name: pending.name });
      if (!isSearch || !pending.id) continue;

      // Wait for the arguments to actually parse. The first chunk of an OpenAI
      // tool call carries `arguments: ""`, which parses to `{}` — recording on
      // that yields a call with an EMPTY query and the search is then rejected
      // as query_too_long. The call is only real once its JSON has an argument.
      let args;
      try { args = JSON.parse(pending.args || ""); } catch { continue; }
      if (typeof args !== "object" || args === null || Array.isArray(args)) continue;
      if (!args.query) continue;

      record(state, pending.id, pending.name, args.query, choice.index, args.search_type);
      state.openAiCalls.delete(slot);
    }
  }
}

/** Walk every block container a Claude frame may use. */
function visitBlocks(json, state) {
  const index = json?.index;
  for (const block of collectBlocks(json)) {
    if (!block || typeof block !== "object") continue;
    if (block.type === SERVER_TOOL_USE_BLOCK) {
      state.sawUpstreamSearch = true;
      record(state, block.id, WEB_SEARCH_TOOL_NAME, block.input?.query, index, block.input?.search_type);
    } else if (block.type === "tool_use"
      && (block.name === WEB_SEARCH_TOOL_NAME || isClaudeCodeSearchTool(block))) {
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
function buildBlocksSse(serverToolUse, toolResult, startIndex = 0) {
  // Anthropic's stream protocol numbers content blocks strictly increasing from
  // 0 and opens/closes each one on its own index. Hardcoding 0 made every
  // injected block collide with the blocks already on the wire, and Claude Code
  // rejected the whole turn with "The model's tool call could not be parsed".
  let i = startIndex;
  const frames = [
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: i, content_block: { type: "text", text: "" } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: i, delta: { type: "text_delta", text: "" } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: i })}\n\n`,
  ];
  i += 1;

  frames.push(
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: i, content_block: serverToolUse })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(serverToolUse.input) } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: i })}\n\n`,
  );
  i += 1;

  frames.push(
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: i, content_block: toolResult })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: i })}\n\n`,
  );
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
      chunks.push(buildBlocksSse(serverToolUse, toolResult, state.nextBlockIndex));
      state.nextBlockIndex += 3;
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
      chunks.push(buildBlocksSse(serverToolUse, toolResult, state.nextBlockIndex));
      state.nextBlockIndex += 3;
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
      chunks.push(buildBlocksSse(serverToolUse, toolResult, state.nextBlockIndex));
      state.nextBlockIndex += 3;
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
function suppressSearchToolUseFrames(text, state) {
  const out = [];

  for (const frame of text.split(/(?<=\n\n)/)) {
    if (!frame) continue;
    const parsed = parseSseFrame(frame);

    if (parsed?.type === "message_stop") state.sawMessageStop = true;

    if (parsed?.type === "content_block_start" && typeof parsed.index === "number") {
      state.nextBlockIndex = Math.max(state.nextBlockIndex, parsed.index + 1);
    }

    if (parsed?.type === "content_block_start" && isSearchToolUseBlock(parsed.content_block)) {
      // Remember the index so the delta/stop frames of this same block, which
      // arrive in later chunks, are recognised as already suppressed.
      state.suppressedIndexes.add(parsed.index);
      continue;
    }
    if (parsed
      && (parsed.type === "content_block_delta" || parsed.type === "content_block_stop")
      && state.suppressedIndexes.has(parsed.index)) {
      continue;
    }
    if (parsed?.type === "message_stop") {
      // Held back: the search blocks must ride inside the turn, before it ends.
      state.sawMessageStop = true;
      continue;
    }
    out.push(frame);
  }
  return out.join("");
}

/** Parse one SSE frame's JSON payload, or null if it carries none. */
function parseSseFrame(frame) {
  for (const line of frame.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === SSE_DONE) continue;
    try { return JSON.parse(payload); } catch { return null; }
  }
  return null;
}

/** A translated `tool_use` block that is the search call the bridge answers. */
function isSearchToolUseBlock(block) {
  if (!block || block.type !== "tool_use") return false;
  return block.name === WEB_SEARCH_TOOL_NAME || isClaudeCodeSearchTool(block);
}

export function injectWebSearchIntoStream({ stream, webSearchPlan, log, runSearch, terminate }) {
  if (!webSearchPlan?.active || webSearchPlan.lane === "passthrough") return stream;

  const state = createWebSearchStreamState();
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let doneReading = false;
  // Frames are the unit of both observation and suppression, so complete frames
  // are buffered until their terminating blank line arrives. An incomplete
  // trailing frame is never forwarded (it would be dropped mid-parse) and never
  // judged (its content_block_start may still be half-written).
  let pending = "";

  /**
   * Consume `text`, returning what may safely be forwarded now.
   * @param {boolean} final flush the trailing partial frame on end-of-stream
   */
  const consume = (text, final = false) => {
    pending += text;
    const parts = pending.split("\n\n");
    // Hold back a trailing fragment that has no terminating blank line yet;
    // on end-of-stream it is complete whether or not it ends in one.
    const tail = final ? "" : (parts.pop() || "");
    pending = final ? "" : tail;

    const whole = [];
    for (const frame of parts) {
      if (!frame) continue;
      const complete = `${frame}\n\n`;
      observeWebSearchFrame(state, complete);
      whole.push(suppressSearchToolUseFrames(complete, state));
    }
    if (final && pending) {
      observeWebSearchFrame(state, pending);
      whole.push(suppressSearchToolUseFrames(pending, state));
      pending = "";
    }
    return whole.join("");
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
        let tail = "";
        try { tail = consume(decoder.decode(), true); } catch { /* ignore */ }
        try { reader.releaseLock(); } catch { /* already released */ }

        if (tail) {
          try { controller.enqueue(new TextEncoder().encode(tail)); } catch { /* client gone */ }
        }

        const injection = await buildStreamWebSearchInjection({ webSearchPlan, state, log, runSearch });
        if (injection) {
          try { controller.enqueue(new TextEncoder().encode(injection)); } catch { /* client gone */ }
        }
        // Close the turn now that the results are inside it. Held back from the
        // upstream stream, so the client never sees an early message_stop.
        if (state.sawMessageStop) {
          const end = `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
          try { controller.enqueue(new TextEncoder().encode(end)); } catch { /* client gone */ }
        }
        try { terminate?.(); } catch { /* ignore */ }
        try { controller.close(); } catch { /* ignore */ }
        return;
      }

      // Forward the chunk with the model's own search tool_use held back: the
      // bridge answers that call with Anthropic's native server-tool pair, and
      // Claude Code would otherwise execute the leftover call locally and report
      // "Did 0 searches" while ignoring the results already sent for it.
      let text = "";
      try { text = consume(decoder.decode(result.value, { stream: true })); } catch { /* ignore */ }

      // A chunk that held nothing but a suppressed block must still enqueue:
      // returning without enqueueing would leave the ReadableStream with nothing
      // to do and it would never call pull() again, stalling the response until
      // the client gave up. An empty enqueue is the correct "kept nothing, keep
      // reading" signal.
      try { controller.enqueue(new TextEncoder().encode(text)); } catch { /* client gone */ }
    },
    cancel(reason) {
      doneReading = true;
      try { reader.cancel(reason); } catch { /* ignore */ }
    },
  });
}
