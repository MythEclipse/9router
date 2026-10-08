// The forced-streaming-to-JSON path (`stream:false` against a forceStream
// provider such as the OpenCode zen relay) must return the body in the
// CLIENT's format. handleNonStreamingResponse already translates for every
// client, but handleForcedSSEToJson returned the raw OpenAI Chat Completions
// body for Anthropic clients — Claude Code reported it as:
//   "API Error: API returned an empty or malformed response (HTTP 200) ...
//    body is JSON but not a Message, request-id absent"
// This test pins the contract: /v1/messages + stream:false => an Anthropic
// `message` body (type/role/content/stop_reason/usage), never `choices`.
import { describe, it, expect } from "vitest";
import { handleForcedSSEToJson } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const OPENAI_SSE =
  'data: {"id":"chatcmpl-forced1","object":"chat.completion.chunk","model":"big-pickle","choices":[{"index":0,"delta":{"role":"assistant","content":"PONG"},"finish_reason":null}]}\n\n' +
  'data: {"id":"chatcmpl-forced1","object":"chat.completion.chunk","model":"big-pickle","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":135,"completion_tokens":1,"total_tokens":136,"prompt_tokens_details":{"cached_tokens":70}}}\n\n' +
  "data: [DONE]\n\n";

function makeProviderResponse(body, contentType = "text/event-stream") {
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
}

async function runForced({ sourceFormat = FORMATS.CLAUDE } = {}) {
  const result = await handleForcedSSEToJson({
    providerResponse: makeProviderResponse(OPENAI_SSE),
    sourceFormat,
    targetFormat: FORMATS.OPENAI,
    provider: "opencode",
    model: "big-pickle",
    body: { model: "big-pickle", stream: false, messages: [] },
    stream: true,
    requestStartTime: Date.now(),
    connectionId: "c1",
    onRequestSuccess: async () => {},
    customToolNames: null,
    toolNameMap: null,
    trackDone: () => {},
    appendLog: () => {},
    reqTag: "test",
    log: null,
  });
  expect(result?.success).toBe(true);
  return { result, json: await result.response.json() };
}

describe("handleForcedSSEToJson respects the client's response format", () => {
  it("returns an Anthropic message body for an Anthropic client", async () => {
    const { result, json } = await runForced({ sourceFormat: FORMATS.CLAUDE });

    // Content-Type must still be JSON (not SSE).
    expect(result.response.headers.get("content-type")).toContain("application/json");

    // Anthropic Message contract.
    expect(json.type).toBe("message");
    expect(json.role).toBe("assistant");
    expect(json.stop_reason).toBe("end_turn");
    expect(Array.isArray(json.content)).toBe(true);
    expect(json.content[0]).toEqual({ type: "text", text: "PONG" });
    expect(json.usage.input_tokens).toBe(65); // 135 prompt - 70 cached
    expect(json.usage.output_tokens).toBe(1);
    expect(json.usage.cache_read_input_tokens).toBe(70);

    // The OpenAI shape must NOT leak through — that is what the SDK
    // rejected with "JSON but not a Message".
    expect(json.choices).toBeUndefined();
    expect(json.object).toBeUndefined();
  });

  it("still returns the raw chat.completion body for an OpenAI client", async () => {
    const { json } = await runForced({ sourceFormat: FORMATS.OPENAI });
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message.content).toBe("PONG");
    expect(json.choices[0].finish_reason).toBe("stop");
    expect(json.type).toBeUndefined();
  });
});