// Standalone semantic check of parseSSEToOpenAIResponse for the exact empty-
// usage frames observed, using vitest (which resolves the @/ alias) instead
// of raw node.
import { describe, it, expect } from "vitest";
import { parseSSEToOpenAIResponse } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";

const usageOnlyChunk = {
  id: "chatcmpl-mai-api-empty",
  object: "chat.completion.chunk",
  model: "big-pickle",
  choices: [],
  usage: { prompt_tokens: 135, completion_tokens: 0, total_tokens: 135 }
};

const deltaStopChunk = {
  id: "chatcmpl-mai-api-empty",
  object: "chat.completion.chunk",
  model: "big-pickle",
  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  usage: { prompt_tokens: 135, completion_tokens: 0, total_tokens: 135 }
};

describe("parseSSEToOpenAIResponse on empty-completion frames", () => {
  it("non-streaming retry sees a usage-only choices:[] body as a valid chat.completion", () => {
    // This is the exact fallback path triggered by Claude Code's "Retrying
    // without streaming". Pre-fix parseSSEToOpenAIResponse returned null -> the
    // handler produced 502 "Invalid SSE response". A usage-tracking-only stream
    // is still evidence of a complete (if empty) response.
    const parsed = parseSSEToOpenAIResponse(
      "data: " + JSON.stringify(usageOnlyChunk) + "\n\ndata: [DONE]\n\n",
      "big-pickle"
    );
    expect(parsed).not.toBeNull();
    expect(parsed.choices?.[0]?.finish_reason).toBe("stop");
    expect(parsed.usage.completion_tokens).toBe(0);
    expect(parsed.choices[0].message.content).toBe("");
  });

  it("finish_reason+usage on a delta-less choices[0] also yields a valid completion", () => {
    const parsed = parseSSEToOpenAIResponse(
      "data: " + JSON.stringify(deltaStopChunk) + "\n\ndata: [DONE]\n\n",
      "big-pickle"
    );
    expect(parsed).not.toBeNull();
    expect(parsed.choices[0].finish_reason).toBe("stop");
    expect(parsed.usage.prompt_tokens).toBe(135);
  });
});