// Regression: an upstream that dies mid-stream (the Vercel relays' 25s
// FUNCTION_INVOCATION_TIMEOUT, or a poolside/OpenCode zen empty completion)
// used to leave 9Router's Claude SSE stream without a terminator. The client
// then reported:
//   "Streaming response ended before any complete data was received.
//    Retrying without streaming... API returned an empty or malformed response
//    (HTTP 200) ... no_events, StreamNoEventsError; 1 stream event received,
//    first after 7561 ms, none in the final 5 ms."
// because only message_start ever went out. The translator must close the
// message itself when the upstream body ends without a finish frame.
import { describe, it, expect } from "vitest";
import { createSSEStream } from "../../open-sse/utils/stream.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

// Feed SSE lines through the real translate pipeline and collect client output.
async function runUpstream(lines) {
  const upstream = new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(enc.encode(line));
      controller.close(); // upstream body ends — no [DONE], no finish_reason
    }
  });

  const transform = createSSEStream({
    mode: "translate",
    targetFormat: FORMATS.OPENAI, // upstream format
    sourceFormat: FORMATS.CLAUDE, // client format (/v1/messages)
    provider: "opencode",
    model: "big-pickle",
    body: { model: "big-pickle", messages: [] }
  });

  const reader = upstream.pipeThrough(transform).getReader();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out;
}

const eventTypes = sse => (sse.match(/^event: .+$/gm) || []).map(e => e.slice(7).trim());

describe("claude SSE stream termination when the upstream dies mid-stream", () => {
  it("closes a stream that only produced message_start (relay cut off before finish_reason)", async () => {
    const out = await runUpstream([
      'data: {"id":"chatcmpl-cut1","object":"chat.completion.chunk","model":"big-pickle","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-cut1","object":"chat.completion.chunk","model":"big-pickle","choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}\n\n'
      // upstream closes here: no finish chunk, no usage trailer, no [DONE]
    ]);

    const types = eventTypes(out);
    expect(types).toContain("message_start");
    expect(types).toContain("message_stop");
    expect(types.at(-1)).toBe("message_stop");
    // the open text block must be closed before the stop
    expect(types).toContain("content_block_stop");
    // exactly one terminal message_delta carrying a stop_reason
    expect(types.filter(t => t === "message_delta")).toHaveLength(1);
    expect(out).toContain('"stop_reason":"end_turn"');
    // partial content is preserved, not dropped
    expect(out).toContain("Hel");
  });

  it("never emits a duplicate terminator when the upstream finished normally", async () => {
    const out = await runUpstream([
      'data: {"id":"chatcmpl-ok","object":"chat.completion.chunk","model":"big-pickle","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-ok","object":"chat.completion.chunk","model":"big-pickle","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-ok","object":"chat.completion.chunk","model":"big-pickle","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n',
      "data: [DONE]\n\n"
    ]);

    const types = eventTypes(out);
    expect(types.filter(t => t === "message_stop")).toHaveLength(1);
    expect(types.filter(t => t === "message_delta")).toHaveLength(1);
    expect(types.at(-1)).toBe("message_stop");
  });

  it("synthesizes a complete message for a usage-only stream with no choices at all", async () => {
    const out = await runUpstream([
      'data: {"id":"chatcmpl-empty","object":"chat.completion.chunk","model":"big-pickle","choices":[],"usage":{"prompt_tokens":135,"completion_tokens":0,"total_tokens":135}}\n\n',
      "data: [DONE]\n\n"
    ]);

    const types = eventTypes(out);
    expect(types[0]).toBe("message_start");
    expect(types.at(-1)).toBe("message_stop");
    expect(out).toContain('"stop_reason":"end_turn"');
    // usage must survive into the message_delta (stream.js buffers every finish
    // chunk via addBufferToUsage, so assert presence + zero output, not the raw)
    expect(out).toContain('"input_tokens":');
    expect(out).toContain('"output_tokens":0');
  });

  it("emits a structured error frame when the upstream yields ZERO events", async () => {
    // A 200 SSE body with nothing in it is the SDK's StreamNoEventsError /
    // "empty or malformed response (HTTP 200)". Closing silently leaves the
    // client with nothing to act on; it must get a real error event.
    const out = await runUpstream(["data: [DONE]\n\n"]);

    const types = eventTypes(out);
    expect(types).toContain("error");
    expect(out).toContain('"type":"error"');
    expect(types).not.toContain("message_start");
  });

  it("does not append an error frame to a stream that did emit events", async () => {
    const out = await runUpstream([
      'data: {"id":"chatcmpl-ok2","object":"chat.completion.chunk","model":"big-pickle","choices":[{"index":0,"delta":{"role":"assistant","content":"Yo"},"finish_reason":null}]}\n\n',
      "data: [DONE]\n\n"
    ]);

    const types = eventTypes(out);
    expect(types).toContain("message_stop");
    expect(types).not.toContain("error");
  });
});
