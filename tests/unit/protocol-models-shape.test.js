import { describe, expect, it, vi } from "vitest";

// static catalog only — no connections/combos so buildModelsList returns the
// static per-provider entries (the no-DB path). Mock localDb to return empty
// arrays, then assert the OpenAI list contract on the output.
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(async () => []),
  getCombos: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
}));
vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: vi.fn(async () => ({})),
}));
// Default exports for the services the route imports that would try a live fetch.
vi.mock("open-sse/services/kiroModels.js", () => ({ resolveKiroModels: async () => null }));
vi.mock("open-sse/services/kimchiModels.js", () => ({ resolveKimchiModels: async () => null }));
vi.mock("open-sse/services/qoderModels.js", () => ({ resolveQoderModels: async () => null, routableQoderModels: () => [] }));
vi.mock("open-sse/services/copilotModels.js", () => ({ resolveCopilotModels: async () => null, resolveClinepassModels: async () => null, resolveClineModels: async () => null }));
vi.mock("open-sse/services/grokCliModels.js", () => ({ resolveGrokCliModels: async () => null }));
vi.mock("open-sse/services/cursorModels.js", () => ({ resolveCursorModels: async () => null }));
vi.mock("open-sse/shared/zedAuth.js", () => ({ resolveZedModels: async () => null }));
vi.mock("@/sse/services/tokenRefresh", () => ({ updateProviderCredentials: async () => {} }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: async () => null }));

const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");

describe("GET /v1/models — OpenAI list contract", () => {
  it("returns object:list and every entry with id/object/owned_by/created", async () => {
    const models = await buildModelsList(["llm"]);
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(m.id).toBeTypeOf("string");
      expect(m.object).toBe("model");
      expect(m.owned_by).toBeTypeOf("string");
      // created must be a deterministically-derived positive epoch integer
      expect(Number.isInteger(m.created)).toBe(true);
      expect(m.created).toBeGreaterThan(0);
    }
  });

  it("created is stable across calls (no Date.now noise)", async () => {
    const a = await buildModelsList(["llm"]);
    const b = await buildModelsList(["llm"]);
    expect(a).toEqual(b);
  });

  it("combo entries carry created too", async () => {
    const getCombos = (await import("@/lib/localDb")).getCombos;
    getCombos.mockResolvedValueOnce([{ name: "combo-a", models: ["cc/claude-opus-5-5", "openai/gpt-5"], kind: "llm" }]);
    const models = await buildModelsList(["llm"]);
    const combo = models.find((m) => m.id === "combo-a");
    expect(combo).toMatchObject({ object: "model", owned_by: "combo" });
    expect(Number.isInteger(combo.created)).toBe(true);
  });
});