/**
 * Unit tests for the live free-model catalogue merge.
 *
 * Free tiers move weekly, so /v1/models and the picker merge the provider's
 * public list at request time (10-min cache) instead of freezing on the curated
 * registry table. These tests pin the merge contract, not any particular
 * upstream model: the fallback keeps the registry promise when the network
 * fails, and live results only fill in what the registry lacks.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Import the real filter/cache module so the contract under test is the one the
// routes import - only the network boundary is stubbed per test.
import {
  fetchSuggestedModelsServer,
  FILTERS,
  FALLBACK_SUGGESTIONS,
} from "@/app/api/providers/suggested-models/filters.js";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("undici", () => ({ fetch: mocks.fetch }));

function jsonResponse(data, { ok = true } = {}) {
  return { ok, json: async () => data };
}

const ZEN = { url: "https://opencode.ai/zen/v1/models", type: "opencode-free" };

describe("fetchSuggestedModelsServer", () => {
  beforeEach(() => {
    mocks.fetch.mockReset();
  });

  it("returns filtered live models when upstream answers", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse({
      data: [
        { id: "brand-new-model-free" },
        { id: "some-paid-model" },
        { id: "big-pickle" },
      ],
    }));
    const data = await fetchSuggestedModelsServer(ZEN);
    const ids = data.map((m) => m.id);
    expect(ids).toContain("brand-new-model-free");
    expect(ids).toContain("big-pickle");
    expect(data.find((m) => m.id === "some-paid-model")?.isFree).toBe(false);
  });

  it("falls back to the registry table when upstream is unreachable", async () => {
    mocks.fetch.mockRejectedValue(new Error("offline"));
    const data = await fetchSuggestedModelsServer({ url: "https://bad.invalid/x", type: "opencode-free" });
    expect(data.length).toBeGreaterThan(0);
    expect(data.map((m) => m.id)).toEqual(
      FALLBACK_SUGGESTIONS["opencode-free"].map((m) => m.id)
    );
  });

  it("falls back when upstream returns nothing usable", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse({ data: [{ id: "test" }, {}] }));
    const data = await fetchSuggestedModelsServer({ url: "https://other.invalid/y", type: "opencode-free" });
    expect(data.map((m) => m.id)).toEqual(
      FALLBACK_SUGGESTIONS["opencode-free"].map((m) => m.id)
    );
  });

  it("rejects unknown filter types instead of passing junk through", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse({ data: [{ id: "x" }] }));
    expect(await fetchSuggestedModelsServer({ url: ZEN.url, type: "nope" })).toEqual([]);
    expect(await fetchSuggestedModelsServer(null)).toEqual([]);
    expect(await fetchSuggestedModelsServer({ url: ZEN.url })).toEqual([]);
  });

  it("marks free models without hiding paid models from the full catalog", () => {
    const filter = FILTERS["opencode-free"];
    const models = filter([
      { id: "a-free" }, { id: "b:free" }, { id: "big-pickle" }, { id: "paid" },
    ]);
    expect(models.map((m) => m.id)).toEqual(["a-free", "b:free", "big-pickle", "paid"]);
    expect(models.find((m) => m.id === "paid")?.isFree).toBe(false);
  });
});