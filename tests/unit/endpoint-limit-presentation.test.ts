import { describe, it, expect } from "vitest";
import {
  formatTokensNumber,
  formatLimitValue,
  limitFieldLabel,
  limitPlaceholder,
  limitHint,
} from "@/app/(dashboard)/dashboard/endpoint/limitPresentation";

describe("formatTokensNumber", () => {
  const legacy = (num: number) => {
    if (!num || num <= 0) return "0";
    if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(2) + "B";
    if (num >= 1_000_000) return (num / 1_000_000).toFixed(2) + "M";
    if (num >= 1_000) return (num / 1_000).toFixed(1) + "K";
    return num.toLocaleString();
  };

  it("matches the expression it replaced", () => {
    const values = [0, 1, -1, 999, 1000, 1500, 999_999, 1_000_000, 1_500_000, 2_500_000_000];
    for (const v of values) expect(formatTokensNumber(v)).toBe(legacy(v));
  });

  it("uses two decimals at B and M so a hand-typed budget reads back exactly", () => {
    expect(formatTokensNumber(1_500_000)).toBe("1.50M");
    expect(formatTokensNumber(1_000_000_000)).toBe("1.00B");
  });

  it("uses one decimal at K", () => {
    expect(formatTokensNumber(12_300)).toBe("12.3K");
  });

  it("groups values below a thousand", () => {
    expect(formatTokensNumber(999)).toBe("999");
    expect(formatTokensNumber(1234)).toBe("1.2K");
  });

  it("renders zero, negatives, null and NaN as 0", () => {
    expect(formatTokensNumber(0)).toBe("0");
    expect(formatTokensNumber(-5)).toBe("0");
    expect(formatTokensNumber(null)).toBe("0");
    expect(formatTokensNumber(NaN)).toBe("0");
  });
});

describe("formatLimitValue", () => {
  it("renders each kind in its own unit", () => {
    expect(formatLimitValue("cost", 2.5)).toBe("$2.50");
    expect(formatLimitValue("requests", 1000)).toBe("1,000 req");
    expect(formatLimitValue("tokens", 1_500_000)).toBe("1.50M tokens");
  });

  it("defaults an unknown kind to tokens", () => {
    expect(formatLimitValue("something-else", 500)).toBe("500 tokens");
  });

  it("renders zero per unit rather than blank", () => {
    expect(formatLimitValue("cost", 0)).toBe("$0.00");
    expect(formatLimitValue("requests", 0)).toBe("0 req");
    expect(formatLimitValue("tokens", 0)).toBe("0 tokens");
  });

  it("treats null as zero", () => {
    expect(formatLimitValue("cost", null)).toBe("$0.00");
  });
});

describe("limitFieldLabel", () => {
  it("names the field per kind", () => {
    expect(limitFieldLabel("cost")).toBe("Cost Limit (USD)");
    expect(limitFieldLabel("requests")).toBe("Request Limit");
    expect(limitFieldLabel("tokens")).toBe("Token Limit");
  });

  it("falls back to tokens for an unknown kind", () => {
    expect(limitFieldLabel("weird")).toBe("Token Limit");
  });
});

describe("limitPlaceholder", () => {
  it("suggests a value of the right magnitude", () => {
    expect(limitPlaceholder("cost")).toBe("2.50");
    expect(limitPlaceholder("requests")).toBe("1000");
    expect(limitPlaceholder("tokens")).toBe("e.g. 88000000");
  });
});

describe("limitHint", () => {
  it("states the per-UTC-day rule for cost, not the per-window rule", () => {
    const hint = limitHint("cost");
    expect(hint).toMatch(/UTC/);
    expect(hint).toMatch(/00:00/);
    expect(hint).not.toMatch(/window resets/);
  });

  it("states the per-window rule for tokens and requests", () => {
    expect(limitHint("tokens")).toMatch(/reset window/);
    expect(limitHint("requests")).toMatch(/window resets/);
  });

  it("says 0 means unlimited in every kind", () => {
    for (const kind of ["tokens", "cost", "requests"]) {
      expect(limitHint(kind)).toMatch(/0 = unlimited/);
    }
  });

  it("appends the creator's ceiling only when there is one", () => {
    expect(limitHint("tokens", 10_000_000)).toContain("Your maximum is 10,000,000 tokens.");
    expect(limitHint("tokens", 0)).not.toContain("Your maximum");
    expect(limitHint("tokens")).not.toContain("Your maximum");
  });

  it("does not print a zero ceiling as a maximum", () => {
    // The guard is `> 0`, so a zero must read as no ceiling at all.
    expect(limitHint("tokens", 0)).not.toMatch(/maximum is 0/);
  });

  it("does not append a maximum to the cost or request hints", () => {
    expect(limitHint("cost", 10_000_000)).not.toContain("Your maximum");
    expect(limitHint("requests", 10_000_000)).not.toContain("Your maximum");
  });

  it("matches the expression it replaced for every kind and ceiling", () => {
    const legacy = (kind: string, creatorTokenLimit = 0) => {
      if (kind === "cost") {
        return "Charges every call at the model's price and adds it up in USD, so the same amount of text costs more on an expensive model. Once today's total (UTC) passes this amount the key answers 429 until 00:00 UTC. 0 = unlimited.";
      }
      if (kind === "requests") {
        return "Counts calls, not size: one call is one request however many tokens it spends, so a huge prompt counts the same as a tiny one. Once the count is reached the key answers 429 until the window resets. 0 = unlimited.";
      }
      const base =
        "Adds up prompt and completion tokens across the reset window, so a long conversation costs more than a short one. When the total is used up the key answers 429 until the window resets. 0 = unlimited.";
      return creatorTokenLimit > 0
        ? `${base} Your maximum is ${creatorTokenLimit.toLocaleString()} tokens.`
        : base;
    };
    for (const kind of ["tokens", "cost", "requests", "unknown"]) {
      for (const ceiling of [0, 1, 1000, 88_000_000]) {
        expect(limitHint(kind, ceiling)).toBe(legacy(kind, ceiling));
      }
    }
  });
});
