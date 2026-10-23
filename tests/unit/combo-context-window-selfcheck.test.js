import { describe, expect, it } from "vitest";
import { comboContextWindow, comboWindowSetting } from "../../open-sse/providers/capabilities.js";

describe("combo context window", () => {
  it("resolves the configured conservative window", () => {
    expect(comboContextWindow([1000000, 350000, 128000])).toBe(128000);
    expect(comboContextWindow([200000, 1000000, 128000], "max")).toBe(1000000);
    expect(comboContextWindow([], "min")).toBeUndefined();
    expect(comboContextWindow(null, "max")).toBeUndefined();
  });

  it("rejects unknown strategy modes", () => {
    expect(comboWindowSetting({ contextWindowMode: "bogus", contextWindow: -5 }))
      .toEqual({ mode: "min", custom: null });
  });
});
