/**
 * Streaming side of the Claude Code auto-mode safeguard review.
 *
 * Claude Code reads `safeguard_results` from the delta of the FINAL
 * `message_delta` event. Two streaming shapes have to be handled:
 *
 *   "translate" — the upstream spoke another format, so 9router synthesizes the
 *     Claude event sequence. We own the final `message_delta`, so we attach
 *     verdicts to it directly.
 *
 *   "passthrough" — Claude→Claude, bytes are relayed. Injecting would require
 *     rewriting the upstream frame; instead we append one extra `message_delta`
 *     carrying only the verdicts. Claude Code reads the field off the last
 *     frame that carries it, so an extra delta does not disturb the transcript.
 *
 * In both cases the verdict map must key on the tool_use.id the client already
 * received, so the ids are captured from the stream as they pass through.
 */

import { buildSafeguardMessageDeltaSse, collectToolUseIds, buildUnavailableResults } from "./safeguardsProtocol.ts";
import { reviewAndBuildSafeguardResults } from "./safeguardsBridge.ts";
import { resolveDecisionCredentials } from "./safeguardsCredentials.ts";
import { SAFEGUARD_STATUS_UNAVAILABLE, SAFEGUARD_STATUS_UNSUPPORTED } from "../config/safeguardsConstants.ts";

/**
 * Accumulated state for one streamed Claude response.
 */
export function createSafeguardStreamState() {
  return { toolUseIds: [], sawFinalDelta: false };
}

/**
 * Note a tool_use block seen in a parsed Claude event.
 * @param {object} state
 * @param {object} event - parsed SSE payload
 */
export function observeSafeguardEvent(state, event) {
  if (!state || !event) return;

  if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
    const id = event.content_block.id;
    if (typeof id === "string" && id && !state.toolUseIds.includes(id)) state.toolUseIds.push(id);
    return;
  }

  // Non-streaming-style shape (a translate backend can emit a whole message).
  if (Array.isArray(event.content)) {
    for (const id of collectToolUseIds(event)) {
      if (!state.toolUseIds.includes(id)) state.toolUseIds.push(id);
    }
    return;
  }

  // The final message_delta: capture an upstream verdict if it carried one.
  if (event.type === "message_delta") {
    const carried = event.delta?.safeguard_results;
    if (Array.isArray(carried)) {
      state.upstreamResults = carried;
    } else if (event.safeguard_results) {
      state.upstreamResults = event.safeguard_results;
    }
  }
}

/**
 * Produce the verdict bytes to append after a streamed Claude response.
 *
 * Returns null when nothing must be injected (no review requested, or no tool
 * call to judge), so the caller leaves the stream byte-identical.
 *
 * @param {object} params
 * @param {object} params.safeguardsPlan
 * @param {object} params.state - from createSafeguardStreamState/observeSafeguardEvent
 * @param {object} [params.log]
 * @param {Function} [params.credentialResolver]
 * @returns {Promise<string|null>} SSE bytes, or null to inject nothing
 */
export async function buildStreamSafeguardInjection({ safeguardsPlan, state, log, credentialResolver }) {
  if (!safeguardsPlan?.active || !state) return null;

  // Upstream reviewed the action itself: relay its verdict untouched.
  if (Array.isArray(state.upstreamResults)) {
    return buildSafeguardMessageDeltaSse({ safeguardResults: state.upstreamResults });
  }

  // No tool call means no call to judge — injecting an empty verdict would
  // tell the client review is "available" with nothing decided.
  if (!Array.isArray(state.toolUseIds) || state.toolUseIds.length === 0) return null;

  if (safeguardsPlan.lane === "passthrough") {
    return buildSafeguardMessageDeltaSse({ safeguardResults: buildUnavailableResults(SAFEGUARD_STATUS_UNSUPPORTED, undefined) });
  }

  const reviewer = safeguardsPlan.reviewer;
  const credentials = await resolveDecisionCredentials({
    provider: reviewer?.provider,
    model: reviewer?.model,
    credentialResolver,
  });
  if (!credentials) {
    log?.warn?.("SAFEGUARD", `no credentials for reviewer ${reviewer?.provider} — reporting unavailable`);
    return buildSafeguardMessageDeltaSse({
      safeguardResults: buildUnavailableResults(SAFEGUARD_STATUS_UNAVAILABLE, "reviewer unavailable"),
    });
  }

  const results = await reviewAndBuildSafeguardResults({
    classifierContext: safeguardsPlan.classifierContext,
    toolUseIds: state.toolUseIds,
    provider: reviewer.provider,
    model: reviewer.model,
    credentials,
    threshold: safeguardsPlan.threshold,
    log,
  });
  return buildSafeguardMessageDeltaSse({ safeguardResults: results });
}

/**
 * Wrap a byte stream so Claude tool ids are observed as they pass, then append
 * the verdict frame once the upstream stream ends.
 *
 * The wrapper is a byte-level tee: it forwards every chunk unchanged and only
 * parses (never rewrites) what it sees, so a parse failure cannot corrupt the
 * response the client receives.
 *
 * @param {object} params
 * @param {ReadableStream} params.stream - upstream SSE stream
 * @param {object} params.safeguardsPlan
 * @param {object} [params.log]
 * @param {Function} [params.credentialResolver]
 * @param {Function} [params.terminate] - run the stream terminator after injection
 * @returns {ReadableStream}
 */
export function injectSafeguardsIntoStream({ stream, safeguardsPlan, log, credentialResolver, terminate }) {
  if (!safeguardsPlan?.active) return stream;

  const state = createSafeguardStreamState();
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  // Frame accumulator. A frame may be split across any number of chunks, so the
  // buffer is only consumed on a "\n\n" boundary; `final` lets the last frame
  // through even when the stream ends without its closing blank line.
  let buffer = "";
  let doneReading = false;

  const observeFrame = (frame) => {
    const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) return;
    const payload = dataLine.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    try {
      observeSafeguardEvent(state, JSON.parse(payload));
    } catch { /* unparseable frame: ignore, never rewrite the stream */ }
  };

  const observe = (text, final = false) => {
    if (!text) return;
    buffer += text;
    const frames = buffer.split("\n\n");
    // Without `final`, the trailing element is an incomplete frame: keep it
    // buffered for the next chunk. With `final`, the stream is over, so a
    // trailing frame without its closing blank line must be parsed too.
    const tail = final ? "" : (frames.pop() || "");
    for (const frame of [...frames, tail]) {
      if (!frame) continue;
      // Cheap gate: only frames that can carry a tool id or a verdict are
      // parsed. Applied to the ACCUMULATED frame, never to a raw chunk — a
      // chunk boundary can fall mid-JSON, leaving "tool_use" in the next chunk
      // while the frame's opening brace is still in this one.
      if (!frame.includes("tool_use") && !frame.includes("safeguard_results")) continue;
      observeFrame(frame);
    }
    buffer = final ? "" : tail;
  };

  // Pumping in `pull` (not `start`) so upstream backpressure is preserved and a
  // slow client is not buffered without bound. The controller MUST be closed on
  // the normal path — omitting it leaves the client's SSE reader waiting
  // forever on a stream that has already ended.
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
        // Flush the buffered partial frame so a trailing tool_use id is not missed,
        // then append the verdict before closing so the client sees it last.
        try { observe(decoder.decode(), true); } catch { /* ignore */ }
        try {
          const bytes = await buildStreamSafeguardInjection({ safeguardsPlan, state, log, credentialResolver });
          if (bytes) controller.enqueue(new TextEncoder().encode(bytes));
        } catch { /* review failed mid-stream: close cleanly, client falls back */ }
        try { reader.releaseLock(); } catch { /* already released */ }
        terminate?.();
        controller.close();
        return;
      }

      try { observe(decoder.decode(result.value, { stream: true })); } catch { /* ignore */ }
      controller.enqueue(result.value);
    },
    cancel(reason) {
      doneReading = true;
      terminate?.();
      return reader.cancel(reason);
    },
  });
}