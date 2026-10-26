// GET /api/usage/request-details returns request/response bodies by default.
//
// The tab exists to answer "what did this request actually contain". A
// redacted-by-default view showed a request that spent 244k input tokens with
// output 0 and no content — indistinguishable from a broken recorder, and no help
// at all in diagnosing whether the payload was missing, truncated, or merely
// hidden. So payloads are returned by default, and the withholding switch is for
// shared/internet-facing instances.
//
// What still has to hold:
//   - a withheld field identifies itself (never a bare {redacted:true}),
//   - turning the switch off withholds every payload field,
//   - an unreadable settings row fails closed,
//   - a gateway with requireLogin disabled does not hand payloads to an
//     unauthenticated caller.
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
let authenticated = true;

vi.mock("@/lib/usageDb.js", () => ({
  getRequestDetails: vi.fn(async () => ({
    details: [JSON.parse(JSON.stringify(sampleDetail))],
    pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1, hasNext: false, hasPrev: false },
  })),
}));

vi.mock("@/lib/localDb", () => ({}));
vi.mock("@/lib/db/repos/settingsRepo.js", () => ({
  getSettings: vi.fn(async () => ({ ...settingsState })),
}));
vi.mock("@/lib/auth/dashboardPermissions", () => ({
  getSessionContext: vi.fn(async () => ({ allowedModels: "*" })),
}));
vi.mock("@/lib/db/repos/allowedModels.js", () => ({
  parseAllowedModels: vi.fn(() => ["*"]),
}));

vi.mock("@/dashboardGuard", () => ({
  isAuthenticated: vi.fn(async () => authenticated),
}));

function makeRequest(query = "?page=1&pageSize=20") {
  return { url: `http://localhost/api/usage/request-details${query}` };
}

async function callRoute() {
  const { GET } = await import("../../src/app/api/usage/request-details/route.js");
  const res = await GET(makeRequest());
  return await res.json();
}

describe("request-details payload policy", () => {
  beforeEach(() => {
    // Mirrors DEFAULT_SETTINGS.observabilityIncludePayloads, which is true.
    settingsState = { observabilityIncludePayloads: true, requireLogin: true };
    authenticated = true;
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns the real payloads for an operator debugging a request", async () => {
    const body = await callRoute();
    expect(body.payloadsIncluded).toBe(true);
    const detail = body.details[0];
    expect(detail.request.messages[0].content).toBe("PROMPT-SECRET-MARKER");
    expect(detail.providerRequest.messages[0].content).toBe("PROMPT-SECRET-MARKER");
    expect(detail.providerResponse.choices[0].message.content).toBe("REPLY-SECRET-MARKER");
    expect(detail.response.content).toBe("REPLY-SECRET-MARKER");
    for (const field of PAYLOAD_FIELDS) {
      expect(detail[field]).not.toHaveProperty("withheld");
    }
  });

  it("withholds every payload field when the operator turns it off", async () => {
    settingsState = { observabilityIncludePayloads: false, requireLogin: true };
    const body = await callRoute();
    expect(body.payloadsIncluded).toBe(false);
    const detail = body.details[0];
    for (const field of PAYLOAD_FIELDS) {
      expect(detail[field]).toMatchObject({ withheld: true, field });
    }
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("PROMPT-SECRET-MARKER");
    expect(serialized).not.toContain("REPLY-SECRET-MARKER");
  });

  it("says a withheld payload exists instead of looking empty", async () => {
    settingsState = { observabilityIncludePayloads: false, requireLogin: true };
    const body = await callRoute();
    const marker = body.details[0].request;
    expect(marker.withheld).toBe(true);
    expect(marker.bytes).toBeGreaterThan(0);
    expect(marker.hint).toMatch(/payload/i);
  });

  it("keeps diagnostic metadata in both modes", async () => {
    for (const include of [true, false]) {
      settingsState = { observabilityIncludePayloads: include, requireLogin: true };
      const body = await callRoute();
      const detail = body.details[0];
      expect(detail.model).toBe("gpt-4o");
      expect(detail.status).toBe("success");
      expect(detail.latency).toEqual({ ttft: 10, total: 20 });
      expect(detail.tokens).toMatchObject({ prompt_tokens: 5, completion_tokens: 2 });
    }
  });

  it("fails closed when the settings row cannot be read", async () => {
    const settingsRepo = await import("@/lib/db/repos/settingsRepo.js");
    settingsRepo.getSettings.mockRejectedValueOnce(new Error("db unavailable"));
    const body = await callRoute();
    expect(body.payloadsIncluded).toBe(false);
    expect(body.details[0].request).toMatchObject({ withheld: true });
  });

  it("does not hand payloads to an unauthenticated caller when login is disabled", async () => {
    // With requireLogin off, /api/usage/* is reachable by anyone who can reach the
    // port; payloads must still require a real session.
    settingsState = { observabilityIncludePayloads: true, requireLogin: false };
    authenticated = false;
    const body = await callRoute();
    expect(body.payloadsIncluded).toBe(false);
    expect(body.details[0].request).toMatchObject({ withheld: true });
  });

  it("still returns payloads to an authenticated caller when login is disabled", async () => {
    settingsState = { observabilityIncludePayloads: true, requireLogin: false };
    authenticated = true;
    const body = await callRoute();
    expect(body.payloadsIncluded).toBe(true);
    expect(body.details[0].request.messages[0].content).toBe("PROMPT-SECRET-MARKER");
  });
});
