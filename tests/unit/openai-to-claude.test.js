/**
 * Unit tests for open-sse/translator/request/openai-to-claude.js
 *
 * Tests cover:
 *  - openaiToClaudeRequest() - OpenAI to Claude request translation
 *  - Response format handling (json_schema, json_object)
 */

import { describe, it, expect } from "vitest";
import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.js";
import { openaiToClaudeResponse } from "../../open-sse/translator/response/openai-to-claude.js";

describe("openaiToClaudeRequest", () => {
  describe("response_format handling", () => {
    it("should inject JSON schema instructions for json_schema type", () => {
      const body = {
        messages: [{ role: "user", content: "What is 2+2?" }],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "math_response",
            schema: {
              type: "object",
              properties: {
                answer: { type: "number" },
                explanation: { type: "string" }
              },
              required: ["answer", "explanation"]
            }
          }
        }
      };

      const result = openaiToClaudeRequest("claude-sonnet-4.5", body, false);

      // Should have system array with instructions
      expect(result.system).toBeDefined();
      expect(Array.isArray(result.system)).toBe(true);
      
      // Check that system prompt includes schema
      const systemText = result.system
        .filter(s => s.type === "text")
        .map(s => s.text)
        .join("\n");
      
      expect(systemText).toContain("You must respond with valid JSON");
      expect(systemText).toContain("\"answer\"");
      expect(systemText).toContain("\"explanation\"");
      expect(systemText).toContain("Respond ONLY with the JSON object");
    });

    it("should inject basic JSON instructions for json_object type", () => {
      const body = {
        messages: [{ role: "user", content: "Give me a JSON object" }],
        response_format: {
          type: "json_object"
        }
      };

      const result = openaiToClaudeRequest("claude-sonnet-4.5", body, false);

      // Should have system array with instructions
      expect(result.system).toBeDefined();
      expect(Array.isArray(result.system)).toBe(true);
      
      const systemText = result.system
        .filter(s => s.type === "text")
        .map(s => s.text)
        .join("\n");
      
      expect(systemText).toContain("You must respond with valid JSON");
      expect(systemText).toContain("Respond ONLY with a JSON object");
    });

    it("should not modify system prompt when response_format is missing", () => {
      const body = {
        messages: [{ role: "user", content: "Hello" }]
      };

      const result = openaiToClaudeRequest("claude-sonnet-4.5", body, false);

      // Should have system but without JSON instructions
      expect(result.system).toBeDefined();
      
      const systemText = result.system
        .filter(s => s.type === "text")
        .map(s => s.text)
        .join("\n");
      
      // Should NOT contain JSON-specific instructions
      expect(systemText).not.toContain("You must respond with valid JSON");
    });

    it("should preserve existing system messages when adding response_format", () => {
      const body = {
        messages: [
          { role: "system", content: "You are a helpful math tutor." },
          { role: "user", content: "What is 2+2?" }
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            schema: {
              type: "object",
              properties: {
                result: { type: "number" }
              }
            }
          }
        }
      };

      const result = openaiToClaudeRequest("claude-sonnet-4.5", body, false);

      // Should preserve original system message
      const systemText = result.system
        .filter(s => s.type === "text")
        .map(s => s.text)
        .join("\n");
      
      expect(systemText).toContain("You are a helpful math tutor");
      expect(systemText).toContain("You must respond with valid JSON");
    });
  });

  describe("tool_choice handling", () => {
    const baseBody = {
      messages: [{ role: "user", content: "add a todo" }],
      tools: [{
        type: "function",
        function: { name: "todo_write", description: "write todos", parameters: { type: "object", properties: {} } }
      }]
    };

    const choiceOf = (tc) =>
      openaiToClaudeRequest("claude-sonnet-4.5", { ...baseBody, tool_choice: tc }, false).tool_choice;

    it("converts OpenAI forced tool ({type:'function'}) to Claude {type:'tool'}", () => {
      // Must NOT leak the OpenAI "function" type — Claude only accepts auto|any|tool|none.
      expect(choiceOf({ type: "function", function: { name: "todo_write" } }))
        .toEqual({ type: "tool", name: "todo_write" });
    });

    it("maps string tool_choice values", () => {
      expect(choiceOf("auto")).toEqual({ type: "auto" });
      expect(choiceOf("none")).toEqual({ type: "auto" });
      expect(choiceOf("required")).toEqual({ type: "any" });
    });

    it("passes through Claude-native tool_choice objects unchanged", () => {
      expect(choiceOf({ type: "tool", name: "todo_write" })).toEqual({ type: "tool", name: "todo_write" });
      expect(choiceOf({ type: "any" })).toEqual({ type: "any" });
      expect(choiceOf({ type: "none" })).toEqual({ type: "none" });
    });

    it("never leaks an invalid type (falls back to auto)", () => {
      // Malformed forced choice with no tool name, and unknown types, must not
      // pass an invalid `type` through to Claude.
      expect(choiceOf({ type: "function", function: {} })).toEqual({ type: "auto" });
      expect(choiceOf({ type: "function" })).toEqual({ type: "auto" });
      expect(choiceOf({ type: "bogus" })).toEqual({ type: "auto" });
    });

    it("omits tool_choice entirely when the request has none", () => {
      const result = openaiToClaudeRequest("claude-sonnet-4.5", baseBody, false);
      expect(result.tool_choice).toBeUndefined();
    });
  });
});

describe("openaiToClaudeResponse", () => {
  it("omits empty Read pages tool argument before emitting Claude input deltas", () => {
    const state = { toolCalls: new Map() };
    const chunk = {
      id: "chatcmpl-test",
      model: "gpt-test",
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_read",
            function: {
              name: "Read",
              arguments: JSON.stringify({
                file_path: "/tmp/example.txt",
                offset: 0,
                limit: 120,
                pages: ""
              })
            }
          }]
        }
      }]
    };

    const result = openaiToClaudeResponse(chunk, state);
    const inputDelta = result.find(event => event.delta?.type === "input_json_delta");

    expect(inputDelta).toBeDefined();
    expect(JSON.parse(inputDelta.delta.partial_json)).toEqual({
      file_path: "/tmp/example.txt",
      offset: 0,
      limit: 120
    });
  });

  it("synthesizes a complete empty message for a usage-only terminal frame (choices: [])", () => {
    // Real shape observed from the OpenCode zen relay / poolside upstream: a
    // stream whose first-and-only data frame has no choices at all, just usage.
    // Pre-fix this produced zero Claude events -> client StreamNoEventsError /
    // "empty or malformed response (HTTP 200)".
    const state = {};
    const chunk = {
      id: "chatcmpl-mai-api-empty",
      model: "big-pickle",
      choices: [],
      usage: {
        prompt_tokens: 135,
        completion_tokens: 0,
        total_tokens: 135,
        prompt_tokens_details: { cached_tokens: 70 }
      }
    };

    const result = openaiToClaudeResponse(chunk, state);
    expect(result).not.toBeNull();

    const types = result.map(e => e.type);
    expect(types[0]).toBe("message_start");
    expect(types).toContain("message_delta");
    expect(types).toContain("message_stop");

    // The synthesized message must carry the upstream usage (cache included).
    const delta = result.find(e => e.type === "message_delta");
    expect(delta.usage.input_tokens).toBe(65); // 135 - 70 cached
    expect(delta.usage.output_tokens).toBe(0);
    expect(delta.usage.cache_read_input_tokens).toBe(70);
    expect(delta.delta.stop_reason).toBe("end_turn");

    // Same chunk again must be a no-op (message already finished).
    const again = openaiToClaudeResponse(chunk, state);
    expect(again).toBeNull();
  });

  it("handles a usage-only interleaved frame after real content without corrupting the stream", () => {
    const state = { toolCalls: new Map() };
    const first = openaiToClaudeResponse({
      id: "chatcmpl-x",
      model: "m",
      choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }]
    }, state);
    expect(first.map(e => e.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta"
    ]);

    const second = openaiToClaudeResponse({
      id: "chatcmpl-x",
      model: "m",
      choices: [],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }
    }, state);
    // message_delta + message_stop must be emitted so the client sees a terminal.
    const secondTypes = second.map(e => e.type);
    expect(secondTypes).toContain("message_delta");
    expect(secondTypes).toContain("message_stop");
  });

  it("handles a choices[0] with null delta (keep-alive frame) without dropping the stream", () => {
    const state = {};
    const result = openaiToClaudeResponse({
      id: "chatcmpl-k",
      model: "m",
      choices: [{ index: 0, delta: null, finish_reason: null }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 }
    }, state);
    // A delta-less frame is not terminal, but must not crash and may synthesize
    // message_start so an empty first frame still yields a valid message.
    expect(result).not.toBeNull();
    expect(result.map(e => e.type)[0]).toBe("message_start");
  });
});
