// Streaming turns can carry reasoning text under several key names.
//
// OpenCode / DeepSeek emit `delta.reasoning`; OpenAI-compatible gateways emit
// `reasoning_content`; some emit `thinking`. `hasValuableContent` is the gate that
// decides whether a chunk is forwarded AND accumulated, so a gate that knows only
// one name silently drops reasoning-only turns: the client sees nothing and the
// observability row records "[Empty streaming response]" while the upstream still
// billed the output tokens. That is what made the request-details feature look
// broken on a real request (244,736 in / 0 out / no content).
import { describe, it, expect } from "vitest";
import { hasValuableContent, extractReasoningText } from "../../open-sse/utils/streamHelpers.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

function openaiChunk(delta) {
  return { choices: [{ index: 0, delta }] };
}

describe("hasValuableContent — reasoning key variants", () => {
  for (const field of ["reasoning_content", "reasoning", "thinking"]) {
    it(`keeps a chunk carrying only delta.${field}`, () => {
      expect(hasValuableContent(openaiChunk({ [field]: "let me think" }), FORMATS.OPENAI)).toBeTruthy();
    });

    it(`ignores an empty delta.${field}`, () => {
      expect(hasValuableContent(openaiChunk({ [field]: "" }), FORMATS.OPENAI)).toBeFalsy();
    });
  }

  it("still keeps plain content", () => {
    expect(hasValuableContent(openaiChunk({ content: "hello" }), FORMATS.OPENAI)).toBeTruthy();
  });

  it("still keeps tool calls and finish_reason", () => {
    expect(hasValuableContent(openaiChunk({ tool_calls: [{ index: 0 }] }), FORMATS.OPENAI)).toBeTruthy();
    expect(
      hasValuableContent({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }, FORMATS.OPENAI)
    ).toBeTruthy();
  });

  it("still drops a truly empty delta", () => {
    expect(hasValuableContent(openaiChunk({}), FORMATS.OPENAI)).toBeFalsy();
  });
});

describe("extractReasoningText", () => {
  it("reads whichever reasoning key the provider used", () => {
    expect(extractReasoningText({ reasoning: "a" })).toBe("a");
    expect(extractReasoningText({ reasoning_content: "b" })).toBe("b");
    expect(extractReasoningText({ thinking: "c" })).toBe("c");
  });

  it("returns empty string for content-only or missing deltas", () => {
    expect(extractReasoningText({ content: "text" })).toBe("");
    expect(extractReasoningText({})).toBe("");
    expect(extractReasoningText(null)).toBe("");
    expect(extractReasoningText(undefined)).toBe("");
  });

  it("does not return a non-string reasoning value", () => {
    expect(extractReasoningText({ reasoning: { text: "nested" } })).toBe("");
    expect(extractReasoningText({ reasoning: 42 })).toBe("");
  });
});
