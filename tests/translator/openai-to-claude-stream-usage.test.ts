import { describe, expect, it } from "vitest";
import "./registerAll.js";
import { openaiToClaudeResponse } from "../../open-sse/translator/response/openai-to-claude.js";

describe("openaiToClaudeResponse — usage from chunk.usage (protocol compliance)", () => {
  const state = () => ({ toolCalls: new Map(), toolArgBuffers: new Map(), messageStartSent: false });

  it("maps prompt/completion tokens into the Claude usage shape", () => {
    const s = state();
    const events = openaiToClaudeResponse({
      id: "chatcmpl-abc",
      model: "gpt-5",
      choices: [{
        index: 0,
        delta: { content: "hello" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    }, s);
    const messageDelta = events.find((e) => e.type === "message_delta");
    expect(messageDelta.usage).toEqual({ input_tokens: 10, output_tokens: 4 });
  });

  it("exposes cache_read/cache_creation from prompt_tokens_details", () => {
    const s = state();
    const events = openaiToClaudeResponse({
      id: "chatcmpl-abc",
      model: "gpt-5",
      choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 2,
        prompt_tokens_details: { cached_tokens: 60, cache_creation_tokens: 10 },
      },
    }, s);
    const messageDelta = events.find((e) => e.type === "message_delta");
    expect(messageDelta.usage).toEqual({
      input_tokens: 30, // 100 - 60 cached - 10 creation
      output_tokens: 2,
      cache_read_input_tokens: 60,
      cache_creation_input_tokens: 10,
    });
  });

  it("starts the message frame with valid ids", () => {
    const s = state();
    const events = openaiToClaudeResponse({
      id: "chatcmpl-abc123",
      model: "gpt-5",
      choices: [{ index: 0, delta: { content: "x" } }],
    }, s);
    const start = events[0];
    expect(start.type).toBe("message_start");
    expect(start.message.type).toBe("message");
    expect(start.message.role).toBe("assistant");
    expect(start.message.content).toEqual([]);
    expect(start.message.stop_reason).toBeNull();
  });
});