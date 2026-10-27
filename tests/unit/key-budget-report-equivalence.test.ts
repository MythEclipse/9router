import { describe, it, expect } from "vitest";
import { limitKindOf, budgetOf, todayKey, spentTodayOf } from "@/lib/usage/keyBudget";

/**
 * Guards the route refactor: the usage report used to derive kind/cap/used inline
 * and the dashboard derived them again. Both now call the same module. This file
 * pins the exact numbers the old inline copy produced, so a future edit to the
 * module cannot silently change what the report shows.
 */

/** The pre-refactor inline derivation, verbatim, for equivalence checking. */
function legacyDerivation(k: any, limit: number, used: number, today: string) {
  const kind = k.limitKind === "cost" || k.limitKind === "requests" ? k.limitKind : "tokens";
  const spentToday = k.costDay === today ? Number(k.costSpent) || 0 : 0;
  const cap = kind === "cost" ? Number(k.dailyCostLimit) || 0
    : kind === "requests" ? Number(k.requestLimit) || 0
    : limit;
  const usedForCap = kind === "cost" ? spentToday
    : kind === "requests" ? Number(k.usedRequests) || 0
    : used;
  return { kind, spentToday, cap, usedForCap };
}

/** The post-refactor derivation, as the route now computes it. */
function currentDerivation(k: any, limit: number, used: number, today: string) {
  const kind = limitKindOf(k);
  const budget = budgetOf(k, { tokenCap: limit, tokenUsed: used, today });
  // costSpentToday is the cost counter unconditionally, not the selected budget's
  // used value: the report shows both "spend today" and the chosen cap, and a
  // token-capped key still has a dollar figure worth reporting.
  const spentToday = spentTodayOf(k, today);
  return { kind, spentToday, cap: budget.cap, usedForCap: budget.used };
}

const TODAY = "2026-01-15";

/**
 * Rows spanning every shape the two views can meet in the database: each kind,
 * a stale and a fresh cost stamp, capped and uncapped, and the degenerate shapes
 * (missing columns, string numbers, unknown kind) that fixtures normally omit.
 */
const ROWS: Array<[string, any, number, number]> = [
  ["token, capped, partially used", { limitKind: "tokens", tokenLimit: 1000, usedTokens: 250 }, 1000, 250],
  ["token, capped, exhausted", { limitKind: "tokens", tokenLimit: 1000, usedTokens: 1000 }, 1000, 1000],
  ["token, overrun", { limitKind: "tokens", tokenLimit: 1000, usedTokens: 4000 }, 1000, 4000],
  ["token, unlimited", { limitKind: "tokens", tokenLimit: 0, usedTokens: 5 }, 0, 5],
  ["token, kind missing", { tokenLimit: 1000, usedTokens: 10 }, 1000, 10],
  ["token, kind unknown", { limitKind: "widgets", tokenLimit: 1000, usedTokens: 10 }, 1000, 10],
  ["token, kind empty string", { limitKind: "", tokenLimit: 1000, usedTokens: 10 }, 1000, 10],
  ["cost, stamped today", { limitKind: "cost", dailyCostLimit: 2, costSpent: 1.5, costDay: TODAY }, 0, 0],
  ["cost, stale stamp", { limitKind: "cost", dailyCostLimit: 2, costSpent: 1.5, costDay: "2026-01-14" }, 0, 0],
  ["cost, no stamp", { limitKind: "cost", dailyCostLimit: 2, costSpent: 1.5 }, 0, 0],
  ["cost, no cap", { limitKind: "cost", dailyCostLimit: 0, costSpent: 9, costDay: TODAY }, 0, 0],
  ["cost, string numbers", { limitKind: "cost", dailyCostLimit: "2.5", costSpent: "2.50", costDay: TODAY }, 0, 0],
  ["requests, capped", { limitKind: "requests", requestLimit: 300, usedRequests: 120, costDay: TODAY }, 0, 0],
  ["requests, exhausted", { limitKind: "requests", requestLimit: 300, usedRequests: 300 }, 0, 0],
  ["requests, no cap", { limitKind: "requests", requestLimit: 0, usedRequests: 77 }, 0, 0],
  ["empty row", {}, 0, 0],
];

describe("usage report derivation is unchanged by the refactor", () => {
  for (const [label, row, limit, used] of ROWS) {
    it(label, () => {
      expect(currentDerivation(row, limit, used, TODAY)).toEqual(legacyDerivation(row, limit, used, TODAY));
    });
  }

  it("agrees across every row in one sweep", () => {
    let checked = 0;
    for (const [, row, limit, used] of ROWS) {
      expect(currentDerivation(row, limit, used, TODAY)).toEqual(legacyDerivation(row, limit, used, TODAY));
      checked += 1;
    }
    expect(checked).toBe(ROWS.length);
  });
});

describe("the dashboard badge reads the same numbers", () => {
  it("shows the same cap and used value the report returns", () => {
    for (const [, row, limit, used] of ROWS) {
      const report = currentDerivation(row, limit, used, TODAY);
      const badge = budgetOf(row, { tokenCap: limit, tokenUsed: used, today: TODAY });
      expect(badge.kind).toBe(report.kind);
      expect(badge.cap).toBe(report.cap);
      expect(badge.used).toBe(report.usedForCap);
    }
  });

  it("marks a key exhausted exactly when the report's percentage reaches 100", () => {
    for (const [, row, limit, used] of ROWS) {
      const report = currentDerivation(row, limit, used, TODAY);
      const percent = report.cap > 0 ? Math.min(100, (report.usedForCap / report.cap) * 100) : null;
      const badge = budgetOf(row, { tokenCap: limit, tokenUsed: used, today: TODAY });
      expect(badge.exhausted).toBe(percent === 100);
    }
  });
});
