// usageHistory grew without bound: one row per request, and nothing ever deleted
// one. requestDetails had a maxRecords cap, this table had nothing, so a gateway
// running for months accumulated an ever-larger SQLite file.
//
// Nothing reads a raw row older than 60 days — 24h/7d/30d/60d come from
// usageHistory, longer windows and lifetime totals come from the usageDaily
// rollup and _meta — so the write path now prunes past a 90-day window.
import { describe, it, expect } from "vitest";
import { saveRequestUsage } from "../../src/lib/db/index.js";
import { getAdapter } from "../../src/lib/db/driver.js";
import { __test__ as usageTest } from "../../src/lib/db/repos/usageRepo.js";

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString();
}

async function historyAt(timestamp) {
  const db = await getAdapter();
  return db.all(`SELECT timestamp FROM usageHistory WHERE timestamp = ?`, [timestamp]);
}

describe("usageHistory retention", () => {
  it("drops rows past the retention window and keeps recent ones", async () => {
    const stale = daysAgo(200);
    const fresh = daysAgo(1);

    await saveRequestUsage({
      provider: "probe-retention",
      model: "m1",
      tokens: { prompt_tokens: 1, completion_tokens: 1 },
      timestamp: fresh,
      status: "ok",
      requestId: "retention-fresh",
    });
    // Seed an out-of-window row directly: saveRequestUsage would still write it,
    // but the prune below is what this test is about, so do not rely on ordering
    // of two writes for it.
    const db = await getAdapter();
    db.run(
      `INSERT INTO usageHistory(timestamp, provider, model, promptTokens, completionTokens, cost, status, tokens, meta) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [stale, "probe-retention", "m-old", 1, 1, 0, "ok", "{}", "{}"],
    );

    expect((await historyAt(stale)).length).toBe(1);

    // The prune is throttled to once an hour per process, and the write above
    // already consumed this run's allowance. Clear it AFTER seeding, so the
    // trigger write below is the one that prunes.
    usageTest.resetHistoryPruneThrottle();

    // Any subsequent non-logOnly write triggers the hourly prune.
    await saveRequestUsage({
      provider: "probe-retention",
      model: "m2",
      tokens: { prompt_tokens: 2, completion_tokens: 2 },
      timestamp: daysAgo(0),
      status: "ok",
      requestId: "retention-trigger",
    });

    expect((await historyAt(stale)).length).toBe(0);
    expect((await historyAt(fresh)).length).toBe(1);
  });

  it("never prunes the row it just wrote, however old its timestamp looks", async () => {
    // A provider that reports a completion long after the fact (or a clock skew
    // on a client-supplied timestamp) must not have its own record deleted.
    const recent = daysAgo(2);
    await saveRequestUsage({
      provider: "probe-retention",
      model: "m3",
      tokens: { prompt_tokens: 3, completion_tokens: 3 },
      timestamp: recent,
      status: "ok",
      requestId: "retention-recent",
    });
    expect((await historyAt(recent)).length).toBe(1);
  });
});
