import { describe, it, expect } from "vitest";
import {
  emptyTotals,
  addToCounter,
  accumulate,
  keepNewest,
  sumTotals,
  type Counter,
} from "@/lib/db/repos/usageCounters";

describe("emptyTotals", () => {
  it("starts every total at zero", () => {
    expect(emptyTotals()).toEqual({ requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 });
  });

  it("returns a fresh object each time", () => {
    const a = emptyTotals();
    a.requests = 9;
    expect(emptyTotals().requests).toBe(0);
  });
});

describe("addToCounter", () => {
  it("counts one request by default", () => {
    const t = emptyTotals();
    addToCounter(t, { promptTokens: 10, completionTokens: 5 });
    expect(t.requests).toBe(1);
    expect(t.promptTokens).toBe(10);
    expect(t.completionTokens).toBe(5);
  });

  it("adds a pre-summed request count when given one", () => {
    const t = emptyTotals();
    addToCounter(t, { requests: 7, cost: 1.5 });
    expect(t.requests).toBe(7);
    expect(t.cost).toBe(1.5);
  });

  it("treats a zero request count as explicit, not as absent", () => {
    // The rollup can carry a 0 for a model that was only price-checked.
    const t = emptyTotals();
    addToCounter(t, { requests: 0 });
    expect(t.requests).toBe(0);
  });

  it("treats missing fields as zero rather than NaN", () => {
    // The request still counts; only the numbers are absent.
    const t = emptyTotals();
    addToCounter(t, {});
    expect(t).toEqual({ ...emptyTotals(), requests: 1 });
    expect(Number.isNaN(t.cost)).toBe(false);
  });

  it("accumulates across calls", () => {
    const t = emptyTotals();
    addToCounter(t, { promptTokens: 3, cost: 0.25 });
    addToCounter(t, { promptTokens: 4, cost: 0.25 });
    expect(t.promptTokens).toBe(7);
    expect(t.cost).toBe(0.5);
    expect(t.requests).toBe(2);
  });
});

describe("accumulate", () => {
  it("creates the bucket on first sight", () => {
    const map: Record<string, Counter> = {};
    const row = accumulate(map, "a", () => ({ ...emptyTotals(), label: "A" }), { promptTokens: 5 });
    expect(row.label).toBe("A");
    expect(row.promptTokens).toBe(5);
    expect(map.a).toBe(row);
  });

  it("adds to an existing bucket and keeps its label", () => {
    const map: Record<string, Counter> = {};
    accumulate(map, "a", () => ({ ...emptyTotals(), label: "A" }), { promptTokens: 5 });
    // A second sight must not reset the bucket to its create() shape.
    accumulate(map, "a", () => ({ ...emptyTotals(), label: "WRONG" }), { promptTokens: 1 });
    expect(map.a.promptTokens).toBe(6);
    expect(map.a.requests).toBe(2);
    expect(map.a.label).toBe("A");
  });

  it("keeps buckets separate by key", () => {
    const map: Record<string, Counter> = {};
    accumulate(map, "a", () => ({ ...emptyTotals() }), { cost: 1 });
    accumulate(map, "b", () => ({ ...emptyTotals() }), { cost: 2 });
    expect(map.a.cost).toBe(1);
    expect(map.b.cost).toBe(2);
  });

  it("returns the same object the map holds, so lastUsed can be set without a lookup", () => {
    const map: Record<string, Counter> = {};
    const row = accumulate(map, "a", () => ({ ...emptyTotals() }), {});
    row.lastUsed = "2026-01-01T00:00:00.000Z";
    expect(map.a.lastUsed).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("keepNewest", () => {
  it("sets the field when it is empty", () => {
    const c: Counter = { ...emptyTotals() };
    keepNewest(c, "lastUsed", "2026-01-01T00:00:00.000Z");
    expect(c.lastUsed).toBe("2026-01-01T00:00:00.000Z");
  });

  it("keeps the later timestamp", () => {
    const c: Counter = { ...emptyTotals(), lastUsed: "2026-01-02T00:00:00.000Z" };
    keepNewest(c, "lastUsed", "2026-01-01T00:00:00.000Z");
    expect(c.lastUsed).toBe("2026-01-02T00:00:00.000Z");
  });

  it("advances to a later timestamp", () => {
    const c: Counter = { ...emptyTotals(), lastUsed: "2026-01-01T00:00:00.000Z" };
    keepNewest(c, "lastUsed", "2026-01-02T00:00:00.000Z");
    expect(c.lastUsed).toBe("2026-01-02T00:00:00.000Z");
  });

  it("compares a day key against an ISO instant correctly", () => {
    // Rollup rows carry YYYY-MM-DD; history rows carry a full ISO string. A day key is
    // midnight UTC, so a same-day ISO instant is later.
    const c: Counter = { ...emptyTotals(), lastUsed: "2026-01-05" };
    keepNewest(c, "lastUsed", "2026-01-05T10:00:00.000Z");
    expect(c.lastUsed).toBe("2026-01-05T10:00:00.000Z");
  });

  it("does not adopt an unparseable timestamp", () => {
    // Otherwise the pipeline's "not a date" placeholder would become the newest and stick.
    const c: Counter = { ...emptyTotals(), lastUsed: "2026-01-02T00:00:00.000Z" };
    keepNewest(c, "lastUsed", "not-a-date");
    expect(c.lastUsed).toBe("2026-01-02T00:00:00.000Z");
  });

  it("ignores a falsy candidate", () => {
    const c: Counter = { ...emptyTotals(), lastUsed: "2026-01-02T00:00:00.000Z" };
    keepNewest(c, "lastUsed", "");
    keepNewest(c, "lastUsed", null);
    keepNewest(c, "lastUsed", undefined);
    expect(c.lastUsed).toBe("2026-01-02T00:00:00.000Z");
  });

  it("replaces an unparseable existing value", () => {
    const c: Counter = { ...emptyTotals(), lastUsed: "garbage" };
    keepNewest(c, "lastUsed", "2026-01-01T00:00:00.000Z");
    expect(c.lastUsed).toBe("2026-01-01T00:00:00.000Z");
  });

  it("matches the comparison it replaced for ISO values", () => {
    const legacy = (current: string, candidate: string) =>
      new Date(candidate) > new Date(current) ? candidate : current;
    const values = [
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.001Z",
      "2025-12-31T23:59:59.999Z",
      "2026-06-15T12:30:00.000Z",
    ];
    for (const a of values) {
      for (const b of values) {
        const c: Counter = { ...emptyTotals(), lastUsed: a };
        keepNewest(c, "lastUsed", b);
        expect(c.lastUsed).toBe(legacy(a, b));
      }
    }
  });
});

describe("sumTotals", () => {
  it("adds every field across buckets", () => {
    const total = sumTotals([
      { requests: 2, promptTokens: 10, completionTokens: 5, cachedTokens: 1, cost: 0.5 },
      { requests: 3, promptTokens: 20, completionTokens: 7, cachedTokens: 2, cost: 1.5 },
    ]);
    expect(total).toEqual({ requests: 5, promptTokens: 30, completionTokens: 12, cachedTokens: 3, cost: 2 });
  });

  it("returns zeros for no buckets", () => {
    expect(sumTotals([])).toEqual(emptyTotals());
  });

  it("treats a missing field as zero", () => {
    const total = sumTotals([{ requests: 1, cost: 2 } as never]);
    expect(total.promptTokens).toBe(0);
    expect(total.cost).toBe(2);
  });
});
