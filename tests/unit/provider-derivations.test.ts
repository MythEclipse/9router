import { describe, it, expect } from "vitest";
import {
  resolveThinkingSuffix,
  providerThinkingLevels,
  summarizeSelectedProxies,
  initialBulkProxyPoolId,
  NO_POOL,
} from "@/app/(dashboard)/dashboard/providers/[id]/providerDerivations";

/**
 * These three derivations decide what the provider page offers and what the bulk
 * proxy edit warns about. They lived in inline IIFEs with no coverage; the cases
 * here pin the rules that were only implicit in that code.
 */

const levels =
  (table: Record<string, string[]>) =>
  (_providerId: string, modelId: string): string[] | null =>
    table[modelId] ?? null;

describe("resolveThinkingSuffix", () => {
  const get = levels({ "gpt-5": ["low", "medium", "high", "none"] });

  it("returns the picked level when the model supports it", () => {
    expect(resolveThinkingSuffix("gpt-5", "high", "openai", get)).toBe("high");
  });

  it("returns null for auto, which means let the router choose", () => {
    expect(resolveThinkingSuffix("gpt-5", "auto", "openai", get)).toBeNull();
  });

  it("returns null when no level is picked", () => {
    expect(resolveThinkingSuffix("gpt-5", null, "openai", get)).toBeNull();
    expect(resolveThinkingSuffix("gpt-5", "", "openai", get)).toBeNull();
    expect(resolveThinkingSuffix("gpt-5", undefined, "openai", get)).toBeNull();
  });

  it("drops a level the model does not support rather than writing a bad id", () => {
    expect(resolveThinkingSuffix("gpt-5", "max", "openai", get)).toBeNull();
  });

  it("returns null for a model with no thinking levels", () => {
    expect(resolveThinkingSuffix("plain", "high", "openai", get)).toBeNull();
  });
});

describe("providerThinkingLevels", () => {
  const get = levels({
    "gpt-5": ["low", "high", "none"],
    "gpt-5-mini": ["low", "medium"],
    "free-model": ["high"],
    "custom-reasoner": ["max"],
    "custom-image": ["high"],
    "other-provider-model": ["ultra"],
  });

  const base = { models: [{ id: "gpt-5" }, { id: "gpt-5-mini" }], storageAlias: "openai" };

  it("unions levels across catalog models and prefixes auto", () => {
    expect(providerThinkingLevels("openai", base, get)).toEqual(["auto", "low", "high", "medium"]);
  });

  it("excludes none, because it is the absence of a level", () => {
    const only = providerThinkingLevels(
      "openai",
      { models: [{ id: "gpt-5" }], storageAlias: "openai" },
      get
    );
    expect(only).not.toContain("none");
  });

  it("returns null when no model reasons, so the picker is hidden", () => {
    expect(providerThinkingLevels("openai", { models: [{ id: "plain" }], storageAlias: "openai" }, get))
      .toBeNull();
    expect(providerThinkingLevels("openai", { models: [], storageAlias: "openai" }, get)).toBeNull();
  });

  it("includes the free-tier catalog", () => {
    const result = providerThinkingLevels(
      "openai",
      { ...base, freeModels: [{ id: "free-model" }] },
      get
    );
    expect(result).toContain("high");
  });

  it("includes custom LLM models belonging to this provider", () => {
    const result = providerThinkingLevels(
      "openai",
      { models: [], storageAlias: "openai", customModels: [{ id: "custom-reasoner", providerAlias: "openai" }] },
      get
    );
    expect(result).toEqual(["auto", "max"]);
  });

  it("ignores custom models owned by another provider", () => {
    expect(
      providerThinkingLevels(
        "openai",
        {
          models: [],
          storageAlias: "openai",
          customModels: [{ id: "other-provider-model", providerAlias: "anthropic" }],
        },
        get
      )
    ).toBeNull();
  });

  it("ignores non-LLM custom models", () => {
    const entries = [
      { id: "custom-image", providerAlias: "openai", kind: "image" },
      { id: "custom-image", providerAlias: "openai", type: "embedding" },
    ];
    expect(
      providerThinkingLevels("openai", { models: [], storageAlias: "openai", customModels: entries }, get)
    ).toBeNull();
  });

  it("treats an entry with no kind as an LLM", () => {
    const result = providerThinkingLevels(
      "openai",
      { models: [], storageAlias: "openai", customModels: [{ id: "custom-reasoner", providerAlias: "openai" }] },
      get
    );
    expect(result).toEqual(["auto", "max"]);
  });

  it("asks about a duplicated model id only once", () => {
    let calls = 0;
    const counting = (p: string, m: string) => {
      calls++;
      return get(p, m);
    };
    providerThinkingLevels(
      "openai",
      { models: [{ id: "gpt-5" }, { id: "gpt-5" }], freeModels: [{ id: "gpt-5" }], storageAlias: "openai" },
      counting
    );
    expect(calls).toBe(1);
  });
});

describe("summarizeSelectedProxies", () => {
  const pools = [{ id: "p1", name: "Datacenter" }, { id: "p2", name: "Residential" }];
  const conn = (poolId?: string) => ({ providerSpecificData: poolId ? { proxyPoolId: poolId } : {} });

  it("hides the line when nothing is selected", () => {
    expect(summarizeSelectedProxies([], pools)).toBe("");
  });

  it("names the shared pool", () => {
    expect(summarizeSelectedProxies([conn("p1"), conn("p1")], pools)).toBe(
      "All selected currently bound to Datacenter"
    );
  });

  it("falls back to the pool id when the pool is unknown", () => {
    expect(summarizeSelectedProxies([conn("gone")], pools)).toBe(
      "All selected currently bound to gone"
    );
  });

  it("reports a uniformly unbound selection", () => {
    expect(summarizeSelectedProxies([conn(), conn(undefined)], pools)).toBe(
      "All selected currently unbound"
    );
  });

  it("reports a mixed selection", () => {
    expect(summarizeSelectedProxies([conn("p1"), conn("p2")], pools)).toBe(
      "Selected connections have mixed proxy bindings"
    );
    expect(summarizeSelectedProxies([conn("p1"), conn()], pools)).toBe(
      "Selected connections have mixed proxy bindings"
    );
  });
});

describe("initialBulkProxyPoolId", () => {
  const conn = (poolId?: string) => ({ providerSpecificData: poolId ? { proxyPoolId: poolId } : {} });

  it("starts on the shared pool", () => {
    expect(initialBulkProxyPoolId([conn("p1"), conn("p1")])).toBe("p1");
  });

  it("starts unbound when the selection is mixed", () => {
    expect(initialBulkProxyPoolId([conn("p1"), conn("p2")])).toBe(NO_POOL);
  });

  it("starts unbound when nothing is bound", () => {
    expect(initialBulkProxyPoolId([conn()])).toBe(NO_POOL);
  });
});

describe("matches the inline versions they replace", () => {
  const get = levels({ a: ["low", "high", "none"], b: ["medium"], c: ["max"] });

  function legacySuffix(modelId: string, thinkingMode: string | null) {
    if (!thinkingMode || thinkingMode === "auto") return null;
    const lv = get("p", modelId);
    return lv && lv.includes(thinkingMode) ? thinkingMode : null;
  }

  function legacyLevels(models: any[], freeModels: any[], customModels: any[], storageAlias: string) {
    const set = new Set<string>();
    const seen = new Set<string>();
    const addLevels = (modelId: string) => {
      if (!modelId || seen.has(modelId)) return;
      seen.add(modelId);
      const lv = get("p", modelId);
      if (lv) lv.forEach((l) => { if (l !== "none") set.add(l); });
    };
    for (const m of models) addLevels(m.id);
    for (const m of freeModels) addLevels(m.id);
    for (const entry of customModels) {
      if (entry.providerAlias !== storageAlias) continue;
      if ((entry.kind || entry.type || "llm") !== "llm") continue;
      addLevels(entry.id);
    }
    return set.size ? ["auto", ...[...set]] : null;
  }

  function legacySummary(selected: any[], proxyPools: any[]) {
    if (selected.length === 0) return "";
    const poolIds = new Set(selected.map((c: any) => c.providerSpecificData?.proxyPoolId || "__none__"));
    if (poolIds.size === 1) {
      const onlyId = [...poolIds][0];
      if (onlyId === "__none__") return "All selected currently unbound";
      const pool = proxyPools.find((p: any) => p.id === onlyId);
      return `All selected currently bound to ${pool?.name || onlyId}`;
    }
    return "Selected connections have mixed proxy bindings";
  }

  it("resolves the same suffix for every mode and model", () => {
    for (const modelId of ["a", "b", "c", "plain"]) {
      for (const mode of [null, "", "auto", "low", "medium", "high", "max"]) {
        expect(resolveThinkingSuffix(modelId, mode, "p", get)).toBe(legacySuffix(modelId, mode));
      }
    }
  });

  it("builds the same level list across a cartesian set of sources", () => {
    const sources = [
      { models: [{ id: "a" }], free: [], custom: [] },
      { models: [{ id: "a" }, { id: "b" }], free: [{ id: "c" }], custom: [] },
      { models: [], free: [], custom: [{ id: "c", providerAlias: "p" }] },
      { models: [], free: [], custom: [{ id: "c", providerAlias: "other" }] },
      { models: [{ id: "plain" }], free: [], custom: [] },
    ];
    for (const source of sources) {
      expect(
        providerThinkingLevels(
          "p",
          {
            models: source.models,
            freeModels: source.free,
            customModels: source.custom,
            storageAlias: "p",
          },
          get
        )
      ).toEqual(legacyLevels(source.models, source.free, source.custom, "p"));
    }
  });

  it("summarises the same message for every binding combination", () => {
    const pools = [{ id: "p1", name: "One" }];
    const bindings = [undefined, "p1", "p2"];
    for (const a of bindings) {
      for (const b of bindings) {
        const selected = [
          { providerSpecificData: a ? { proxyPoolId: a } : {} },
          { providerSpecificData: b ? { proxyPoolId: b } : {} },
        ];
        expect(summarizeSelectedProxies(selected, pools)).toBe(legacySummary(selected, pools));
      }
    }
    expect(summarizeSelectedProxies([], pools)).toBe(legacySummary([], pools));
  });
});
