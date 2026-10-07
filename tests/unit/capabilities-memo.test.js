// The capability lookup is memoized per (provider, model) — caching bugs are
// silent, so pin the three properties that matter: same answer every time,
// never a shared mutable object, and a real drop when the catalog changes.
import { describe, it, expect, beforeEach } from "vitest";
import {
  getCapabilitiesForModel,
  setCatalogSource,
  DEFAULT_CAPABILITIES,
} from "../../open-sse/providers/capabilities.js";

const MODEL = "gpt-5";

describe("getCapabilitiesForModel memoization", () => {
  beforeEach(() => {
    // Each test starts from the same empty-catalog state as a fresh process.
    setCatalogSource(null);
  });

  it("returns the same answer on every call", () => {
    const first = getCapabilitiesForModel("openai", MODEL);
    const second = getCapabilitiesForModel("openai", MODEL);
    expect(second).toEqual(first);
  });

  it("never hands back the cached object itself", () => {
    const first = getCapabilitiesForModel("openai", MODEL);
    const second = getCapabilitiesForModel("openai", MODEL);
    expect(second).not.toBe(first);

    // A caller mutating its result must not poison the cache.
    first.contextWindow = -1;
    expect(getCapabilitiesForModel("openai", MODEL).contextWindow).not.toBe(-1);
  });

  it("still merges DEFAULT_CAPABILITIES", () => {
    const caps = getCapabilitiesForModel("openai", MODEL);
    for (const key of Object.keys(DEFAULT_CAPABILITIES)) {
      expect(caps, key).toHaveProperty(key);
    }
  });

  it("keys the memo by provider, not just by model id", () => {
    // An id no table knows: provider-less resolves to the floor...
    const UNKNOWN = "totally-unknown-model-xyz";
    expect(getCapabilitiesForModel(null, UNKNOWN).contextWindow)
      .toBe(DEFAULT_CAPABILITIES.contextWindow);
    // ...while the same id under a provider-specific branch does not.
    expect(getCapabilitiesForModel("commandcode", UNKNOWN).contextWindow)
      .toBe(1000000);

    // Repeating each must keep its own answer — no bleed across cache keys.
    expect(getCapabilitiesForModel(null, UNKNOWN).contextWindow)
      .toBe(DEFAULT_CAPABILITIES.contextWindow);
    expect(getCapabilitiesForModel("commandcode", UNKNOWN).contextWindow)
      .toBe(1000000);
  });

  it("returns the default floor for a missing model", () => {
    expect(getCapabilitiesForModel("openai", null)).toEqual({ ...DEFAULT_CAPABILITIES });
    expect(getCapabilitiesForModel("openai", "")).toEqual({ ...DEFAULT_CAPABILITIES });
  });

  it("picks up a new catalog source instead of serving the stale memo", () => {
    const before = getCapabilitiesForModel("openai", MODEL);
    expect(before.contextWindow).not.toBe(424242);

    setCatalogSource({
      getModalities: () => null,
      getLimits: () => ({ contextWindow: 424242, maxOutput: 4096 }),
    });
    const withCatalog = getCapabilitiesForModel("openai", MODEL);
    expect(withCatalog.contextWindow).toBe(424242);

    // ...and dropping the source must not leave the catalog values behind.
    setCatalogSource(null);
    expect(getCapabilitiesForModel("openai", MODEL).contextWindow)
      .not.toBe(424242);
  });

  it("keeps the memo consistent across a source identity change", () => {
    const makeSource = (window) => ({
      getModalities: () => null,
      getLimits: () => ({ contextWindow: window, maxOutput: 1 }),
    });

    setCatalogSource(makeSource(111111));
    expect(getCapabilitiesForModel("openai", MODEL).contextWindow).toBe(111111);

    // Same shape, different object: identity is what invalidates.
    setCatalogSource(makeSource(222222));
    expect(getCapabilitiesForModel("openai", MODEL).contextWindow).toBe(222222);
  });
});
