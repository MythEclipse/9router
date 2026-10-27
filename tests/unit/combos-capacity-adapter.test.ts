import { describe, it, expect } from "vitest";
import {
  normalizeCapEntry,
  normalizeCapacityAdapter,
  getPolicyBadgeLabel,
  addCapModel,
  removeCapModelAt,
  removeCapModel,
  moveCapModel,
  upgradeLegacyModel,
  EMPTY_CAP_ENTRY,
  DEFAULT_FALLBACK_MODEL,
  CAPACITY_ADAPTER_CAPS,
} from "@/app/(dashboard)/dashboard/combos/capacityAdapter";

describe("normalizeCapEntry", () => {
  it("reads the current object shape", () => {
    expect(normalizeCapEntry({ enabled: false, roundRobin: true, models: ["a", "b"] })).toEqual({
      enabled: false,
      roundRobin: true,
      models: ["a", "b"],
    });
  });

  it("treats a missing enabled flag as enabled", () => {
    // Stored entries predate the toggle; they were all active by definition.
    expect(normalizeCapEntry({ models: ["a"] }).enabled).toBe(true);
    expect(normalizeCapEntry({ enabled: null, models: [] }).enabled).toBe(true);
  });

  it("reads the legacy array shape as enabled, without rotation", () => {
    expect(normalizeCapEntry([{ model: "a" }, "b"])).toEqual({
      enabled: true,
      roundRobin: false,
      models: ["a", "b"],
    });
  });

  it("upgrades the retired free model id on both shapes", () => {
    expect(normalizeCapEntry(["oc/mimo-v2.5-free"]).models).toEqual([DEFAULT_FALLBACK_MODEL]);
    expect(normalizeCapEntry({ models: ["oc/mimo-v2.5-free"] }).models).toEqual([
      DEFAULT_FALLBACK_MODEL,
    ]);
  });

  it("drops blank string entries from the legacy shape", () => {
    expect(normalizeCapEntry(["", "a", ""]).models).toEqual(["a"]);
    expect(normalizeCapEntry({ models: ["a", ""] }).models).toEqual(["a"]);
  });

  it("drops a legacy entry whose model is blank instead of storing '[object Object]'", () => {
    expect(normalizeCapEntry([{ model: "" }]).models).toEqual([]);
    expect(normalizeCapEntry([{ model: "" }, { model: "a" }]).models).toEqual(["a"]);
    expect(normalizeCapEntry([{ model: null }]).models).toEqual([]);
  });

  it("returns a fresh empty entry for junk, never the shared constant", () => {
    const entry = normalizeCapEntry(null);
    expect(entry).toEqual(EMPTY_CAP_ENTRY);
    expect(entry).not.toBe(EMPTY_CAP_ENTRY);
    expect(normalizeCapEntry(42)).toEqual(EMPTY_CAP_ENTRY);
    expect(normalizeCapEntry(undefined)).toEqual(EMPTY_CAP_ENTRY);
  });

  it("gives each empty entry its own models array", () => {
    // A shared array would let one capability's edits appear on another.
    const a = normalizeCapEntry(null);
    const b = normalizeCapEntry(null);
    a.models.push("leak");
    expect(b.models).toEqual([]);
    expect(EMPTY_CAP_ENTRY.models).toEqual([]);
  });
});

describe("normalizeCapacityAdapter", () => {
  it("returns an entry for every known capability", () => {
    const adapter = normalizeCapacityAdapter({ vision: { models: ["v"] } });
    for (const cap of CAPACITY_ADAPTER_CAPS) {
      expect(adapter[cap.key]).toBeDefined();
    }
    expect(adapter.vision.models).toEqual(["v"]);
    expect(adapter.audioInput).toEqual(EMPTY_CAP_ENTRY);
  });

  it("survives a null or non-object settings blob", () => {
    expect(normalizeCapacityAdapter(null).vision).toEqual(EMPTY_CAP_ENTRY);
    expect(normalizeCapacityAdapter("junk").vision).toEqual(EMPTY_CAP_ENTRY);
  });

  it("keeps only the visible capabilities, dropping hidden ones from memory", () => {
    // Matches the original: the loop covers CAPACITY_ADAPTER_CAPS, so pdf/videoInput
    // are not carried in component state even when stored settings still hold them.
    const adapter = normalizeCapacityAdapter({ pdf: { models: ["p"] } });
    expect(adapter.pdf).toBeUndefined();
  });
});

describe("getPolicyBadgeLabel", () => {
  it("defaults to the smart badge", () => {
    expect(getPolicyBadgeLabel({})).toBe("Smart (≥80%)");
    expect(getPolicyBadgeLabel()).toBe("Smart (≥80%)");
  });

  it("names the strict and per-turn policies", () => {
    expect(getPolicyBadgeLabel({ smartPolicy: "strict" })).toBe("Strict Lock");
    expect(getPolicyBadgeLabel({ smartPolicy: "per-turn" })).toBe("Per-Turn");
  });

  it("infers per-turn when session stickiness is off", () => {
    expect(getPolicyBadgeLabel({ sessionSticky: false })).toBe("Per-Turn");
  });

  it("lets an explicit policy override the stickiness flag", () => {
    expect(getPolicyBadgeLabel({ smartPolicy: "smart", sessionSticky: false })).toBe("Smart (≥80%)");
  });

  it("renders a fractional threshold as a percentage", () => {
    expect(getPolicyBadgeLabel({ smartPolicy: "custom", confidenceThreshold: 0.85 })).toBe(
      "Custom (≥85%)"
    );
  });

  it("renders a percentage-scale threshold unchanged", () => {
    // Both scales are in stored data, so the scale is inferred rather than assumed.
    expect(getPolicyBadgeLabel({ smartPolicy: "custom", confidenceThreshold: 92 })).toBe(
      "Custom (≥92%)"
    );
    expect(getPolicyBadgeLabel({ smartPolicy: "custom", confidenceThreshold: 1 })).toBe(
      "Custom (≥100%)"
    );
  });

  /**
   * A custom policy with no threshold means the default 80%. It used to read 1%,
   * because `(raw || 0.8) * (raw && ...)` multiplied 0.8 by 0 for a falsy raw.
   */
  it("defaults a missing or zero threshold to 80%", () => {
    expect(getPolicyBadgeLabel({ smartPolicy: "custom" })).toBe("Custom (≥80%)");
    expect(getPolicyBadgeLabel({ smartPolicy: "custom", confidenceThreshold: 0 })).toBe(
      "Custom (≥80%)"
    );
  });

  it("reads a percentage-scale threshold between 1 and 2 as a percentage", () => {
    // 1.5 is a percentage, not a fraction: the old code truncated it to 2%.
    expect(getPolicyBadgeLabel({ smartPolicy: "custom", confidenceThreshold: 1.5 })).toBe(
      "Custom (≥2%)"
    );
    expect(getPolicyBadgeLabel({ smartPolicy: "custom", confidenceThreshold: 1.2 })).toBe(
      "Custom (≥1%)"
    );
  });
});

describe("addCapModel", () => {
  it("appends a new model", () => {
    expect(addCapModel(["a"], "b")).toEqual(["a", "b"]);
  });

  it("accepts a picker object by value or name", () => {
    expect(addCapModel([], { value: "v" })).toEqual(["v"]);
    expect(addCapModel([], { name: "n" })).toEqual(["n"]);
  });

  it("prefers value over name when both are present", () => {
    expect(addCapModel([], { value: "v", name: "n" })).toEqual(["v"]);
  });

  it("ignores a duplicate", () => {
    const models = ["a"];
    expect(addCapModel(models, "a")).toBe(models);
  });

  it("ignores a blank", () => {
    const models = ["a"];
    expect(addCapModel(models, "")).toBe(models);
    expect(addCapModel(models, null)).toBe(models);
    expect(addCapModel(models, {})).toBe(models);
  });
});

describe("removeCapModelAt", () => {
  it("removes by index", () => {
    expect(removeCapModelAt(["a", "b", "c"], 1)).toEqual(["a", "c"]);
  });

  it("resets to the default instead of leaving the pool empty", () => {
    // An empty pool would leave the adapter switched on but serving nothing.
    expect(removeCapModelAt(["a"], 0)).toEqual([DEFAULT_FALLBACK_MODEL]);
  });

  it("is a no-op for an out-of-range index on a non-empty list", () => {
    expect(removeCapModelAt(["a", "b"], 9)).toEqual(["a", "b"]);
  });
});

describe("removeCapModel", () => {
  it("removes by value", () => {
    expect(removeCapModel(["a", "b"], "a")).toEqual(["b"]);
  });

  it("removes a picker object by value", () => {
    expect(removeCapModel(["a", "b"], { value: "b" })).toEqual(["a"]);
  });

  it("resets to the default instead of leaving the pool empty", () => {
    expect(removeCapModel(["a"], "a")).toEqual([DEFAULT_FALLBACK_MODEL]);
  });

  it("does nothing when the value is absent", () => {
    expect(removeCapModel(["a"], "zzz")).toEqual(["a"]);
  });
});

describe("moveCapModel", () => {
  it("swaps with the neighbour above and below", () => {
    expect(moveCapModel(["a", "b"], 0, 1)).toEqual(["b", "a"]);
    expect(moveCapModel(["a", "b"], 1, -1)).toEqual(["b", "a"]);
  });

  it("returns the list unchanged at either boundary", () => {
    const models = ["a", "b", "c"];
    expect(moveCapModel(models, 0, -1)).toBe(models);
    expect(moveCapModel(models, 2, 1)).toBe(models);
  });

  it("does not mutate the input", () => {
    const models = ["a", "b"];
    moveCapModel(models, 0, 1);
    expect(models).toEqual(["a", "b"]);
  });

  it("moves across a long list one step at a time", () => {
    let models = ["a", "b", "c", "d"];
    for (let i = 0; i < 3; i++) models = moveCapModel(models, i, 1);
    expect(models).toEqual(["b", "c", "d", "a"]);
  });
});

describe("upgradeLegacyModel", () => {
  it("rewrites only the retired id", () => {
    expect(upgradeLegacyModel("oc/mimo-v2.5-free")).toBe(DEFAULT_FALLBACK_MODEL);
    expect(upgradeLegacyModel("openai/gpt-5")).toBe("openai/gpt-5");
  });
});
