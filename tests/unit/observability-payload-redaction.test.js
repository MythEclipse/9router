// GET /api/usage/request-details withholds request/response bodies by default.
// That redaction is deliberate (8a527fec): the stored details hold full prompts,
// tool calls and provider responses, so returning them to any dashboard user
// turns the observability tab into a conversation-history reader.
//
// What this guards is that the redaction stays (a) ON by default, (b) liftable by
// an explicit setting, and (c) legible — the old marker was `{redacted:true}`,
// indistinguishable from "this request had no payload", which reads as a storage
// bug.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const sampleDetail = {
  id: "detail-1",
  provider: "openai",
  model: "gpt-4o",
  timestamp: "2026-01-01T00:00:00.000Z",
  status: "success",
  latency: { ttft: 10, total: 20 },
  tokens: { prompt_tokens: 5, completion_tokens: 2 },
  request: { messages: [{ role: "user", content: "PROMPT-SECRET-MARKER" }] },
  providerRequest: { messages: [{ role: "user", content: "PROMPT-SECRET-MARKER" }] },
  providerResponse: { choices: [{ message: { content: "REPLY-SECRET-MARKER" } }] },
  response: { content: "REPLY-SECRET-MARKER" },
};

const PAYLOAD_FIELDS = ["request", "providerRequest", "providerResponse", "response"];

let settingsState = {};
let lastResponse = null;

vi.mock("@/lib/usageDb.js", () => ({
  getRequestDetails: vi.fn(async () => ({
    details: [JSON.parse(JSON.stringify(sampleDetail))],
    pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1, hasNext: false, hasPrev: false },
  })),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => ({ ...settingsState })),
}));

function makeRequest(query = "?page=1&pageSize=20") {
  return { url: `http://localhost/api/usage/request-details${query}` };
}

async function callRoute() {
  const { GET } = await import("../../src/app/api/usage/request-details/route.js");
  const res = await GET(makeRequest());
  lastResponse = await res.json();
  return lastResponse;
}

describe("request-details payload redaction", () => {
  beforeEach(() => {
    settingsState = {};
    lastResponse = null;
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("withholds all four payload fields by default", async () => {
    const body = await callRoute();
    expect(body.payloadsIncluded).toBe(false);
    const detail = body.details[0];
    for (const field of PAYLOAD_FIELDS) {
      expect(detail[field]).toMatchObject({ withheld: true });
    }
    // The secret content must not appear anywhere in the response.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("PROMPT-SECRET-MARKER");
    expect(serialized).not.toContain("REPLY-SECRET-MARKER");
  });

  it("still returns metadata needed to diagnose a request", async () => {
    const body = await callRoute();
    const detail = body.details[0];
    expect(detail.model).toBe("gpt-4o");
    expect(detail.provider).toBe("openai");
    expect(detail.status).toBe("success");
    expect(detail.latency).toEqual({ ttft: 10, total: 20 });
    expect(detail.tokens).toMatchObject({ prompt_tokens: 5, completion_tokens: 2 });
  });

  it("explains the withholding instead of looking like a missing payload", async () => {
    const body = await callRoute();
    const marker = body.details[0].request;
    expect(marker.withheld).toBe(true);
    expect(marker.field).toBe("request");
    // Byte count proves the payload WAS stored; a bare {redacted:true} made a
    // populated request look identical to an empty one.
    expect(marker.bytes).toBeGreaterThan(0);
    expect(marker.hint).toMatch(/payload/i);
  });

  it("returns real payloads once the operator opts in", async () => {
    settingsState = { observabilityIncludePayloads: true };
    const body = await callRoute();
    expect(body.payloadsIncluded).toBe(true);
    const detail = body.details[0];
    expect(detail.request.messages[0].content).toBe("PROMPT-SECRET-MARKER");
    expect(detail.response.content).toBe("REPLY-SECRET-MARKER");
    for (const field of PAYLOAD_FIELDS) {
      expect(detail[field]).not.toHaveProperty("withheld");
    }
  });

  it("fails closed when the settings row cannot be read", async () => {
    const localDb = await import("@/lib/localDb");
    localDb.getSettings.mockRejectedValueOnce(new Error("db unavailable"));
    const body = await callRoute();
    expect(body.payloadsIncluded).toBe(false);
    expect(body.details[0].request).toMatchObject({ withheld: true });
  });
});
