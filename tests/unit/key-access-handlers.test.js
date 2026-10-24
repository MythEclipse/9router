// Per-API-key access control: every /v1 handler type is wired to the gate, the
// gate runs before any credential lookup, and a restricted key calling an allowed
// combo keeps combo failover (real combo.js).
import { describe, it, expect, vi, beforeEach } from "vitest";

const fx = vi.hoisted(() => ({
  combos: [
    { id: "c1", name: "Main", models: ["openai/model-a", "openai/model-b"] },
  ],
  studios: {},
  keys: {},
}));
const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  handleChatCore: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: true, comboStrategy: "fallback" }),
  shouldLogAuthFailure: () => false,
  isValidApiKey: async () => true,
  getModelAliases: async () => ({}),
  getStudioModel: async (name) => fx.studios[name] || null,
  getComboByName: async (name) => fx.combos.find((c) => c.name === name) || null,
  getProviderNodes: async () => [],
  getCombos: async () => fx.combos,
  getProviderConnections: async () => [],
  getProviderConnectionById: async () => null,
  getCustomModels: async () => [],
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => ({}) }));
vi.mock("@/lib/db/repos/combosRepo.js", () => ({ getCombos: async () => fx.combos }));
vi.mock("@/lib/db/repos/modelEditorRepo.js", () => ({
  getStudioModel: async (name) => fx.studios[name] || null,
  getModelOverride: async () => null,
}));
vi.mock("@/lib/db/repos/aliasRepo.js", () => ({ getModelAliases: async () => ({}) }));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({
  getApiKeyByKey: async (k) => fx.keys[k] || null,
  getAllowedModelsOfKey: async (k) => fx.keys[k]?.access?.restricted ? fx.keys[k].access.allow : null,
  matchesAllowedModels: (patterns, model) => !patterns || patterns.some((pattern) => pattern.toLowerCase() === model.toLowerCase()),
}));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn() }));
vi.mock("@/sse/services/auth.js", () => ({
  apiKeyGateFailure: (valid, requireApiKey = true) => {
    if (valid === true) return null;
    if (valid === "KEY_DISABLED") return { status: 403, message: "API key is disabled" };
    if (!requireApiKey) return null;
    const failures = {
      KEY_EXPIRED: { status: 403, message: "API key has expired" },
      MODEL_NOT_ALLOWED: { status: 403, message: "This model is not allowed for the API key" },
      QUOTA_EXCEEDED: { status: 429, message: "API key token limit exceeded" },
      REQUEST_LIMIT_EXCEEDED: { status: 429, message: "API key request limit exceeded" },
      COST_LIMIT_EXCEEDED: { status: 429, message: "API key daily cost limit exceeded" },
      RPM_EXCEEDED: { status: 429, message: "API key rate limit exceeded (RPM limit reached)" },
      TPM_EXCEEDED: { status: 429, message: "API key rate limit exceeded (TPM limit reached)" },
    };
    return failures[valid] || { status: 401, message: "Invalid API key" };
  },
  getProviderCredentials: mocks.getProviderCredentials,
  getApiKey: async (key) => fx.keys[key] || null,
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
  clearAccountError: vi.fn(),
  extractApiKey: (request) => {
    const a = request.headers.get("Authorization");
    return a?.startsWith("Bearer ") ? a.slice(7) : request.headers.get("x-api-key");
  },
  isValidApiKey: async () => true,
  shouldLogAuthFailure: () => false,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_p, c) => c,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));

const { handleChat } = await import("../../src/sse/handlers/chat.js");
const { handleEmbeddings } = await import("../../src/sse/handlers/embeddings.js");
const { handleImageGeneration } = await import("../../src/sse/handlers/imageGeneration.js");
const { handleTts } = await import("../../src/sse/handlers/tts.js");
const { handleStt } = await import("../../src/sse/handlers/stt.js");
const { handleVideoCreate } = await import("../../src/sse/handlers/videoGeneration.js");
const { handleSearch } = await import("../../src/sse/handlers/search.js");
const { handleFetch } = await import("../../src/sse/handlers/fetch.js");
const { handleSystemone } = await import("../../src/sse/handlers/systemone.js");
const geminiRoute = await import("../../src/app/api/v1beta/models/[...path]/route.js");
const modelsRoute = await import("../../src/app/api/v1/models/route.js");
const modelsKindRoute = await import("../../src/app/api/v1/models/[...model]/route.js");

const enc = new TextEncoder();
const sse = (frames) => new Response(new ReadableStream({
  start(c) { for (const f of frames) c.enqueue(enc.encode(f)); c.close(); },
}), { status: 200, headers: { "Content-Type": "text/event-stream" } });
const ROLE = `data: {"id":"x","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n`;
const CONTENT = (t) => `data: {"id":"x","choices":[{"index":0,"delta":{"content":"${t}"},"finish_reason":null}]}\n\n`;
const DONE = `data: [DONE]\n\n`;

const auth = (k) => (k ? { Authorization: `Bearer ${k}` } : {});
const post = (path, body, k, extra = {}) => new Request(`http://localhost${path}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...auth(k), ...extra },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  fx.keys = {
    "test-key-6": { id: "o", name: "open", isActive: true, access: { restricted: false, allow: [] } },
    "test-key-2": { id: "c", name: "combo", isActive: true, access: { restricted: true, allow: ["Main"] } },
    "test-key-7": { id: "s", name: "studio", isActive: true, access: { restricted: true, allow: ["Main"] } },
    "test-key-8": { id: "sm", name: "studio-model", isActive: true, access: { restricted: true, allow: ["openai/model-b"] } },
    "test-key-1": { id: "b", name: "b", isActive: true, access: { restricted: true, allow: ["openai/model-b"] } },
    "test-key-3": { id: "e", name: "empty", isActive: true, access: { restricted: true, allow: [] } },
    "test-key-4": {
      id: "m", name: "media", isActive: true,
      access: {
        restricted: true,
        allow: ["openai/text-embedding-3-small", "openai/dall-e-3", "openai/tts-1", "openai/whisper-1",
          "xai/grok-imagine-video", "tavily", "openai/gpt-4o", "gemini/gemini-2.5-flash-preview-tts"],
      },
    },
  };
  mocks.getProviderCredentials.mockResolvedValue(null);
  // model-a always fails upstream (500), so a combo of [model-a, model-b] only
  // succeeds by failing over to model-b.
  mocks.handleChatCore.mockImplementation(async ({ modelInfo }) => (modelInfo.model === "model-a"
    ? {
      success: false, status: 500, error: "upstream error",
      response: new Response(JSON.stringify({ error: { message: "upstream error" } }), { status: 500, headers: { "Content-Type": "application/json" } }),
    }
    : { success: true, response: sse([ROLE, CONTENT(`from-${modelInfo.model}`), DONE]) }));
});

const chat = (model, k) => handleChat(post("/v1/chat/completions", { model, stream: true, messages: [{ role: "user", content: "hi" }] }, k));

beforeEach(() => {
  fx.studios = { workhorse: { targetModel: "Main" }, modelalias: { targetModel: "openai/model-b" } };
});

describe("chat (/v1/chat/completions, /v1/messages, /v1/responses all use handleChat)", () => {
  beforeEach(() => mocks.getProviderCredentials.mockResolvedValue({ connectionId: "conn", connectionName: "mock" }));

  it("unrestricted key reaches the provider for the combo and models", async () => {
    for (const m of ["Main", "openai/model-b"]) {
      expect((await chat(m, "test-key-6")).status).toBe(200);
    }
    expect((await chat("openai/model-a", "test-key-6")).status).toBe(500); // provider error, not a 403
  });
  it("restricted keys authorize a studio alias by its resolved combo or model target", async () => {
    expect((await chat("workhorse", "test-key-7")).status).toBe(200);
    expect((await chat("modelalias", "test-key-8")).status).toBe(200);
    vi.clearAllMocks();
    expect((await chat("workhorse", "test-key-8")).status).toBe(403);
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });

  it("restricted-to-combo key: combo 200, direct member and unlisted model 403 before any credential lookup", async () => {
    expect((await chat("Main", "test-key-2")).status).toBe(200);
    vi.clearAllMocks();
    for (const m of ["openai/model-a", "openai/model-b", "openai/gpt-4o"]) {
      const r = await chat(m, "test-key-2");
      expect(r.status).toBe(403);
    }
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });
  it("restricted-to-model-B key: B 200; the combo containing B and model A are 403", async () => {
    expect((await chat("openai/model-b", "test-key-1")).status).toBe(200);
    vi.clearAllMocks();
    // Bypass check: a per-member check would skip the failing model-a and serve
    // the combo from model-b. The combo itself is not listed, so it is a 403.
    expect((await chat("Main", "test-key-1")).status).toBe(403);
    expect((await chat("openai/model-a", "test-key-1")).status).toBe(403);
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });
  it("empty-list key: 403 on everything", async () => {
    for (const m of ["Main", "openai/model-a", "openai/model-b"]) expect((await chat(m, "test-key-3")).status).toBe(403);
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });
  it("restricted key on an allowed combo still fails over from an erroring member to the next", async () => {
    const r = await chat("Main", "test-key-2");
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain("from-model-b");
    const tried = mocks.handleChatCore.mock.calls.map(([a]) => a.modelInfo.model);
    expect(tried).toEqual(["model-a", "model-b"]);
  });
  it("bypass check: a restricted key sent as x-goog-api-key on the Gemini-compatible route is still restricted", async () => {
    const res = await geminiRoute.POST(
      new Request("http://localhost/v1beta/models/openai/model-a:generateContent", {
        method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": "test-key-1" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
      }),
      { params: Promise.resolve({ path: ["openai", "model-a:generateContent"] }) },
    );
    expect(res.status).toBe(403);
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });
});

// Each non-chat handler: [name, call(model, key), allowedModel, deniedModel]
const handlers = [
  ["embeddings", (m, k) => handleEmbeddings(post("/v1/embeddings", { model: m, input: "x" }, k)), "openai/text-embedding-3-small", "openai/text-embedding-3-large"],
  ["image", (m, k) => handleImageGeneration(post("/v1/images/generations", { model: m, prompt: "x" }, k)), "openai/dall-e-3", "openai/gpt-image-1"],
  ["tts", (m, k) => handleTts(post("/v1/audio/speech", { model: m, input: "x" }, k)), "openai/tts-1", "openai/tts-1-hd"],
  ["stt", (m, k) => {
    const fd = new FormData();
    fd.set("model", m);
    fd.set("file", new Blob([new Uint8Array(4)], { type: "audio/wav" }), "a.wav");
    return handleStt(new Request("http://localhost/v1/audio/transcriptions", { method: "POST", headers: auth(k), body: fd }));
  }, "openai/whisper-1", "groq/whisper-large-v3"],
  ["video", (m, k) => handleVideoCreate(post("/v1/videos/generations", { model: m, prompt: "x" }, k), "generations"), "xai/grok-imagine-video", "xai/grok-imagine-video-pro"],
  ["search", (m, k) => handleSearch(post("/v1/search", { model: m, query: "x" }, k)), "tavily", "exa"],
  ["fetch", (m, k) => handleFetch(post("/v1/web/fetch", { model: m, url: "https://example.com" }, k)), "tavily", "firecrawl"],
  ["systemone", (m, k) => handleSystemone(post("/v1/systemone", { model: m, state: {}, questions: { q: "?" } }, k)), "openai/gpt-4o", "openai/gpt-4.1"],
  ["gemini-native-tts", (m, k) => geminiRoute.POST(
    new Request(`http://localhost/v1beta/models/${m}:generateContent`, {
      method: "POST", headers: { "Content-Type": "application/json", ...auth(k) },
      body: JSON.stringify({ contents: [{ parts: [{ text: "x" }] }], generationConfig: { responseModalities: ["AUDIO"] } }),
    }),
    { params: Promise.resolve({ path: [`${m}:generateContent`] }) },
  ), "gemini-2.5-flash-preview-tts", "gemini-2.5-pro-preview-tts"],
];

describe.each(handlers)("%s handler is wired", (_name, call, allowed, denied) => {
  it("denies an unlisted model with 403 before any credential lookup", async () => {
    const r = await call(denied, "test-key-4");
    expect(r.status).toBe(403);
    expect((await r.json()).error.message).toContain(denied);
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
  });
  it("lets a listed model through to the credential lookup", async () => {
    const r = await call(allowed, "test-key-4");
    expect(r.status).not.toBe(403);
    expect(mocks.getProviderCredentials).toHaveBeenCalled();
  });
  it("leaves an unrestricted key alone", async () => {
    const r = await call(denied, "test-key-6");
    expect(r.status).not.toBe(403);
  });
  it("denies everything for the empty-list key", async () => {
    expect((await call(allowed, "test-key-3")).status).toBe(403);
  });
});

describe("video: a body without a readable model is denied for restricted keys", () => {
  it("multipart / no model -> 403 for restricted, untouched for unrestricted", async () => {
    const noModel = (k) => handleVideoCreate(post("/v1/videos/generations", { prompt: "x" }, k), "generations");
    expect((await noModel("test-key-4")).status).toBe(403);
    expect((await noModel("test-key-6")).status).not.toBe(403);
  });
});

describe("/v1/models routes filter by key", () => {
  const list = async (k) => {
    const response = await modelsRoute.GET(new Request("http://localhost/v1/models", { headers: auth(k) }));
    const payload = await response.json();
    if (!response.ok) throw new Error(`models GET ${response.status}: ${JSON.stringify(payload)}`);
    return payload.data.map((m) => m.id);
  }

  it("unrestricted sees the full catalog; restricted keys see only their entries", async () => {
    const all = await list("test-key-6");
    expect(all).toContain("Main");
    const someModel = all.find((id) => id.startsWith("openai/"));
    expect(someModel).toBeTruthy();
    fx.keys["test-key-5"] = { id: "x", name: "mix", isActive: true, access: { restricted: true, allow: ["Main", someModel.toUpperCase()] } };
    expect(await list("test-key-5")).toEqual(["Main", someModel]);
    expect(await list("test-key-2")).toEqual(["Main"]);
    expect(await list("test-key-3")).toEqual([]);
    await expect(list(null)).rejects.toThrow("models GET 401");
  });
  it("/v1/models/{kind} and single-model lookup are filtered too", async () => {
    const kind = async (k, path) => modelsKindRoute.GET(new Request(`http://localhost/v1/models/${path.join("/")}`, { headers: auth(k) }), { params: Promise.resolve({ model: path }) });
    const emb = await (await kind("test-key-6", ["embedding"])).json();
    expect(emb.data.length).toBeGreaterThan(0);
    expect((await (await kind("test-key-3", ["embedding"])).json()).data).toEqual([]);
    const all = (await (await modelsRoute.GET(new Request("http://localhost/v1/models", { headers: auth("test-key-6") }))).json()).data;
    const one = all.find((m) => m.owned_by !== "combo").id;
    expect((await kind("test-key-6", one.split("/"))).status).toBe(200);
    expect((await kind("test-key-3", one.split("/"))).status).toBe(404);
  });
});
