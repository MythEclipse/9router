import { describe, expect, it } from "vitest";
import { validateResponsesBody, isResponsesEndpoint } from "../../src/sse/protocol/responsesValidation.js";

describe("isResponsesEndpoint", () => {
  it("matches /v1/responses and subpaths only", () => {
    expect(isResponsesEndpoint("/v1/responses")).toBe(true);
    expect(isResponsesEndpoint("/v1/responses/compact")).toBe(true);
    expect(isResponsesEndpoint("/v1/chat/completions")).toBe(false);
    expect(isResponsesEndpoint("/v1/messages")).toBe(false);
  });
});

describe("validateResponsesBody", () => {
  it("accepts string and array input", () => {
    expect(validateResponsesBody({ model: "m", input: "hello" })).toBeNull();
    expect(validateResponsesBody({ model: "m", input: [{ type: "message", role: "user", content: "hi" }] })).toBeNull();
  });

  it("requires input", async () => {
    const res = validateResponsesBody({ model: "m" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("input");
    // OpenAI Responses clients parse the OpenAI envelope
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("rejects non-string/non-array input", async () => {
    const res = validateResponsesBody({ model: "m", input: 42 });
    const body = await res.json();
    expect(body.error.message).toContain("input");
  });

  it("rejects invalid body shapes", async () => {
    expect((await validateResponsesBody(null).json()).error.message).toContain("Invalid");
    expect((await validateResponsesBody([]).json()).error.message).toContain("Invalid");
  });
});