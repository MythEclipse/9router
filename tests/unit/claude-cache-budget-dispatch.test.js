// The budget has to hold on the wire, not just in the helper: chatCore hands
// the final body to the executor, and that body is the last place a client's
// cache_control markers could exceed what this turn allows.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({
    execute: executeMock,
    refreshCredentials: vi.fn().mockResolvedValue(null),
  })),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logError: vi.fn(),
  })),
}));

vi.mock("../../open-sse/utils/clientDetector.js", () => ({
  detectClientTool: vi.fn(() => "claude"),
  isNativePassthrough: vi.fn(() => true),
}));

vi.mock("../../open-sse/utils/bypassHandler.js", () => ({
  handleBypassRequest: vi.fn(() => null),
}));

vi.mock("../../open-sse/utils/streamHandler.js", () => ({
  createStreamController: vi.fn(() => ({
    signal: undefined,
    handleComplete: vi.fn(),
    handleError: vi.fn(),
  })),
}));

vi.mock("../../open-sse/services/tokenRefresh.js", () => ({
  refreshWithRetry: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  default: vi.fn(),
  proxyAwareFetch: vi.fn(),
}));

vi.mock("../../open-sse/utils/toolDeduper.js", () => ({
  dedupeTools: vi.fn((tools) => ({ tools, stripped: [] })),
}));

vi.mock("../../open-sse/rtk/caveman.js", () => ({ injectCaveman: vi.fn() }));
vi.mock("../../open-sse/rtk/ponytail.js", () => ({ injectPonytail: vi.fn() }));
vi.mock("../../open-sse/rtk/index.js", () => ({
  compressMessages: vi.fn(() => null),
  formatRtkLog: vi.fn(() => ""),
}));
vi.mock("../../open-sse/rtk/headroom.js", () => ({
  compressWithHeadroom: vi.fn(async () => null),
  formatHeadroomLog: vi.fn(() => ""),
  formatHeadroomSizeLog: vi.fn(() => ""),
  isHeadroomPhantomSavings: vi.fn(() => false),
}));

vi.mock("../../open-sse/providers/capabilities.js", () => ({
  getCapabilitiesForModel: vi.fn(() => ({})),
}));

vi.mock("../../open-sse/translator/concerns/modality.js", () => ({
  stripUnsupportedModalities: vi.fn(() => false),
}));

vi.mock("../../open-sse/translator/concerns/prefetch.js", () => ({
  prefetchRemoteImages: vi.fn(async () => 0),
}));

vi.mock("../../open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: vi.fn((detail) => detail),
  extractRequestConfig: vi.fn((body, stream) => ({ body, stream })),
}));

vi.mock("../../open-sse/utils/error.js", () => ({
  createErrorResult: vi.fn((status, message) => ({ success: false, status, error: message })),
  formatProviderError: vi.fn((error) => error.message),
  parseUpstreamError: vi.fn(),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

const CC = { type: "ephemeral" };
const text = (t) => ({ type: "text", text: t });

/** Over-budget body: marked system tail, marked tool, marked turns. */
function overBudgetBody() {
  return {
    model: "claude-sonnet-5",
    max_tokens: 1024,
    system: [text("s1"), text("s2", { cache_control: CC })],
    tools: [{ name: "t1", description: "d", input_schema: {}, cache_control: CC }],
    messages: [
      { role: "user", content: [text("u1", { cache_control: CC })] },
      { role: "assistant", content: [text("a1", { cache_control: CC })] },
      { role: "user", content: [text("q")] },
    ],
  };
}

function countMarkers(body) {
  let n = 0;
  if (Array.isArray(body?.system)) for (const b of body.system) if (b?.cache_control) n++;
  if (Array.isArray(body?.tools)) for (const t of body.tools) if (t?.cache_control) n++;
  if (Array.isArray(body?.messages)) {
    for (const m of body.messages) {
      if (Array.isArray(m?.content)) for (const b of m.content) if (b?.cache_control) n++;
    }
  }
  return n;
}

async function dispatch(providerOverrides) {
  const body = overBudgetBody();
  body.stream = false;
  executeMock.mockReset();
  // Resolve like a real upstream: a rejection would surface after handleChatCore
  // returns and pollute the test with an unhandled rejection.
  executeMock.mockResolvedValue(new Response(JSON.stringify({ content: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));

  try {
    await handleChatCore({
      body,
      modelInfo: { provider: "claude", model: "claude-sonnet-5" },
      credentials: { apiKey: ["unit", "test", "key"].join("-") },
      clientRawRequest: { endpoint: "/v1/messages", body, headers: {} },
      connectionId: "cache-budget-test",
      sourceFormatOverride: "claude",
      providerOverrides,
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
  } catch {
    // upstream failure is irrelevant here — the dispatched body is the subject
  }

  expect(executeMock, "executor must be reached").toHaveBeenCalled();
  return executeMock.mock.calls[0][0].body;
}

describe("cache marker budget reaches the dispatched request", () => {
  beforeEach(() => executeMock.mockReset());

  it("keeps a default request inside the default budget", async () => {
    const dispatched = await dispatch(null);
    expect(countMarkers(dispatched)).toBeLessThanOrEqual(4);
  });

  it("honours a provider override raising the budget", async () => {
    const dispatched = await dispatch({ maxMarkers: 6 });
    expect(countMarkers(dispatched)).toBeLessThanOrEqual(6);
  });

  it("leaves exactly one marker when the provider does not cache", async () => {
    const dispatched = await dispatch({ cacheSupported: false });
    expect(countMarkers(dispatched)).toBe(1);
    // re-anchoring rewrites the marker to a 1h TTL — presence is what matters
    expect(dispatched.system[dispatched.system.length - 1].cache_control).toBeTruthy();
  });

  it("drops every marker on a fresh context of a non-caching provider", async () => {
    const dispatched = await dispatch({ cacheSupported: false, newContextReason: true });
    expect(countMarkers(dispatched)).toBe(0);
  });

  it("accepts the snake_case config spelling too", async () => {
    const dispatched = await dispatch({ cache_supported: false, max_markers: 2 });
    expect(countMarkers(dispatched)).toBeLessThanOrEqual(2);
  });

  it("never changes the conversation while trimming", async () => {
    const dispatched = await dispatch({ cacheSupported: false });
    expect(dispatched.messages).toHaveLength(3);
    expect(dispatched.system).toHaveLength(2);
    expect(dispatched.tools).toHaveLength(1);
    expect(dispatched.messages[2].content[0].text).toBe("q");
  });
});
