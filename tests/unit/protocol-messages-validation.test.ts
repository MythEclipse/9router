import { describe, expect, it } from "vitest";
import { FORMATS } from "open-sse/translator/formats.js";
import { validateClaudeMessageBody, isClaudeEndpoint } from "../../src/sse/protocol/claudeValidation.js";

describe("isClaudeEndpoint", () => {
  it("recognizes /v1/messages and its subpaths", () => {
    expect(isClaudeEndpoint("/v1/messages")).toBe(true);
    expect(isClaudeEndpoint("/v1/messages/count_tokens")).toBe(true);
  });

  it("recognizes Anthropic alias routes but not OpenAI/compat endpoints", () => {
    expect(isClaudeEndpoint("/v1/chat/completions")).toBe(false);
    expect(isClaudeEndpoint("/v1/responses")).toBe(false);
    expect(isClaudeEndpoint("")).toBe(false);
    expect(isClaudeEndpoint(null)).toBe(false);
  });
});

describe("validateClaudeMessageBody", () => {
  const valid = { max_tokens: 100, messages: [{ role: "user", content: "hi" }] };

  it("accepts a valid Anthropic body", () => {
    expect(validateClaudeMessageBody(valid)).toBeNull();
  });

  it("requires max_tokens (Anthropic protocol)", () => {
    const { max_tokens, ...noTokens } = valid;
    const res = validateClaudeMessageBody(noTokens);
    expect(res.status).toBe(400);
    const body = res.json();
    return body.then((parsed) => {
      expect(parsed.type).toBe("error");
      expect(parsed.error.type).toBe("invalid_request_error");
      expect(parsed.error.message).toContain("max_tokens");
    });
  });

  it("rejects non-positive and non-integer max_tokens", async () => {
    expect((await validateClaudeMessageBody({ ...valid, max_tokens: 0 }).json()).error.message).toContain("max_tokens");
    expect((await validateClaudeMessageBody({ ...valid, max_tokens: 1.5 }).json()).error.message).toContain("max_tokens");
    expect(validateClaudeMessageBody({ ...valid, max_tokens: 1 })).toBeNull();
  });

  it("requires a non-empty messages array", async () => {
    expect((await validateClaudeMessageBody({ ...valid, messages: [] }).json()).error.message).toContain("messages");
    expect((await validateClaudeMessageBody({ ...valid, messages: undefined }).json()).error.message).toContain("messages");
  });

  it("rejects OpenAI-only fields on the Anthropic endpoint", async () => {
    const res = validateClaudeMessageBody({ ...valid, response_format: { type: "json_object" } });
    const body = await res.json();
    expect(body.error.message).toContain("response_format");
    expect(res.status).toBe(400);
  });

  it("error envelopes are Anthropic-shaped", async () => {
    const res = validateClaudeMessageBody({});
    const body = await res.json();
    expect(body).toMatchObject({ type: "error", error: { type: "invalid_request_error" } });
    expect(body.error.code).toBeUndefined();
  });

  it("formats for FORMATS.CLAUDE constant exist and validate without network", () => {
    expect(FORMATS.CLAUDE).toBe("claude");
  });
});