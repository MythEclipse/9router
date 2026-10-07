import { describe, expect, it } from "vitest";
import { FORMATS } from "open-sse/translator/formats.js";
import {
  buildErrorBody,
  errorResponse,
  unavailableResponse,
  createErrorResult,
  writeStreamError,
} from "open-sse/utils/error.js";
import { buildStreamErrorBytes } from "open-sse/utils/streamHelpers.js";

describe("buildErrorBody protocol envelopes", () => {
  it("keeps the OpenAI envelope by default", () => {
    expect(buildErrorBody(400, "bad", null)).toEqual({
      error: { message: "bad", type: "invalid_request_error", code: "bad_request" },
    });
    expect(buildErrorBody(429, "limited", null)).toMatchObject({
      error: { type: "rate_limit_error", code: "rate_limit_exceeded" },
    });
  });

  it("emits the Anthropic Messages envelope for FORMATS.CLAUDE", () => {
    const body = buildErrorBody(400, "Invalid request body", FORMATS.CLAUDE);
    expect(body).toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: "Invalid request body" },
    });
  });

  it("maps known Anthropic error types per status", () => {
    expect(buildErrorBody(401, "x", FORMATS.CLAUDE).error.type).toBe("authentication_error");
    expect(buildErrorBody(403, "x", FORMATS.CLAUDE).error.type).toBe("permission_error");
    expect(buildErrorBody(404, "x", FORMATS.CLAUDE).error.type).toBe("not_found_error");
    expect(buildErrorBody(429, "x", FORMATS.CLAUDE).error.type).toBe("rate_limit_error");
    expect(buildErrorBody(503, "x", FORMATS.CLAUDE).error.type).toBe("overloaded_error");
    expect(buildErrorBody(500, "x", FORMATS.CLAUDE).error.type).toBe("api_error");
  });

  it("never leaks code into the Anthropic envelope", () => {
    const body = buildErrorBody(429, "x", FORMATS.CLAUDE);
    expect(body.error.code).toBeUndefined();
  });
});

describe("errorResponse / unavailableResponse envelope routing", () => {
  it("errorResponse keeps the OpenAI body for default callers", async () => {
    const res = errorResponse(400, "Invalid JSON body");
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.error.message).toBe("Invalid JSON body");
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBe("bad_request");
  });

  it("errorResponse emits Anthropic envelope when clientFormat=claude", async () => {
    const res = errorResponse(400, "max_tokens: field required", null, FORMATS.CLAUDE);
    const body = await res.json();
    expect(body.type).toBe("error");
    expect(body.error).toMatchObject({ type: "invalid_request_error" });
    expect(body.error.message).toContain("max_tokens");
  });

  it("unavailableResponse now carries error type/code like OpenAI expects", async () => {
    const retryAt = new Date(Date.now() + 60000).toISOString();
    const res = unavailableResponse(503, "[openai] busy", retryAt, "60s");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.message).toContain("busy");
    expect(body.error.type).toBe("server_error");
    expect(body.error.code).toBe("service_unavailable");
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(30);
  });

  it("unavailableResponse emits Anthropic envelope for claude endpoints", async () => {
    const retryAt = new Date(Date.now() + 60000).toISOString();
    const res = unavailableResponse(503, "[claude] busy", retryAt, "60s", null, FORMATS.CLAUDE);
    const body = await res.json();
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("overloaded_error");
    expect(body.error.message).toContain("busy");
  });

  it("createErrorResult routes the envelope too", async () => {
    const { response } = createErrorResult(429, "limited", undefined, null, FORMATS.CLAUDE);
    const body = await response.json();
    expect(body).toEqual({
      type: "error",
      error: { type: "rate_limit_error", message: "limited" },
    });
  });
});

describe("streamed error frames follow the client protocol", () => {
  it("writeStreamError emits event: error for Claude clients", async () => {
    const chunks = [];
    const writer = {
      write: async (bytes) => { chunks.push(new TextDecoder().decode(bytes)); },
    };
    await writeStreamError(writer, 429, "rate limited", FORMATS.CLAUDE);
    const text = chunks.join("");
    expect(text).toMatch(/^event: error\ndata: /);
    const payload = JSON.parse(text.split("\n")[1].slice(5));
    expect(payload.type).toBe("error");
    expect(payload.error.type).toBe("rate_limit_error");
  });

  it("writeStreamError keeps plain data frame for OpenAI clients", async () => {
    const chunks = [];
    const writer = {
      write: async (bytes) => { chunks.push(new TextDecoder().decode(bytes)); },
    };
    await writeStreamError(writer, 429, "rate limited");
    expect(chunks.join("")).toBe('data: {"error":{"message":"rate limited","type":"rate_limit_error","code":"rate_limit_exceeded"}}\n\n');
  });

  it("buildStreamErrorBytes wraps the Claude envelope (not OpenAI shape) in event: error", () => {
    const bytes = buildStreamErrorBytes(504, "stalled", FORMATS.CLAUDE);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("event: error");
    const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
    const payload = JSON.parse(dataLine.slice(6));
    expect(payload.type).toBe("error");
    expect(payload.error.type).toBe("api_error");
    expect(payload.error.code).toBeUndefined();
  });

  it("buildStreamErrorBytes keeps OpenAI frame + [DONE] for OpenAI clients", () => {
    const bytes = buildStreamErrorBytes(504, "stalled", FORMATS.OPENAI);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('"type":"server_error"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });
});