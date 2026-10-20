// Regression: usageDaily.byAccount used to be keyed by connectionId alone, with
// a single rawModel meta field overwritten by whichever model wrote last. An
// account running three models therefore reported ONE row — labelled with the
// last model — carrying all three models' tokens. The dashboard groups these
// rows by accountName and shows the model per row, so two of the three models
// vanished from the Account tab while their tokens inflated the third.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
let db;
// The suite-wide setup file owns DATA_DIR for the whole worker. Capture its
// value and restore THAT on teardown — `delete process.env.DATA_DIR` would leave
// every later file in this worker pointing at the user's real ~/.9router.
const originalDataDir = process.env.DATA_DIR;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-by-account-"));
  process.env.DATA_DIR = tempDir;
  // The adapter, ring and daily cache all live on `global` to survive Next.js
  // hot reload, so a bare vi.resetModules() keeps pointing at the PREVIOUS
  // test's database and its rows leak into this one.
  delete global._dbAdapter;
  delete global._recentRing;
  delete global._pendingRequests;
  delete global._pendingTimers;
  delete global._connectionMapCache;
  delete global._statsEmitTimers;
  delete global._lastErrorProvider;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  delete global._recentRing;
  delete global._pendingRequests;
  delete global._pendingTimers;
  delete global._connectionMapCache;
  delete global._statsEmitTimers;
  delete global._lastErrorProvider;
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

const base = {
  provider: "opencode",
  connectionId: "acct-1",
  apiKey: "sk-probe-key-000001",
  endpoint: "/v1/chat/completions",
  status: "ok",
};

async function seed() {
  const now = Date.now();
  await db.saveRequestUsage({ ...base, model: "beam-free", tokens: { prompt_tokens: 100, completion_tokens: 10 }, timestamp: new Date(now - 3000).toISOString() });
  await db.saveRequestUsage({ ...base, model: "beam-free", tokens: { prompt_tokens: 200, completion_tokens: 20 }, timestamp: new Date(now - 2000).toISOString() });
  await db.saveRequestUsage({ ...base, model: "big-pickle", tokens: { prompt_tokens: 300, completion_tokens: 30 }, timestamp: new Date(now - 1000).toISOString() });
  await db.saveRequestUsage({ ...base, model: "mimo-v2.6-flash-free", tokens: { prompt_tokens: 400, completion_tokens: 40 }, timestamp: new Date(now).toISOString() });
}

describe("usage stats — per-account rows keep the model dimension", () => {
  it("reports one row per (account, model) instead of collapsing the account", async () => {
    await seed();

    // period "all" reads the usageDaily aggregate (the collapsed path).
    const stats = await db.getUsageStats("all");
    const rows = Object.values(stats.byAccount);

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.rawModel).sort()).toEqual(
      ["beam-free", "big-pickle", "mimo-v2.6-flash-free"]
    );
    // Beam-free's two requests aggregate into one row; the other two stand alone.
    expect(rows.find((r) => r.rawModel === "beam-free").promptTokens).toBe(300);
    expect(rows.find((r) => r.rawModel === "big-pickle").promptTokens).toBe(300);
    expect(rows.find((r) => r.rawModel === "mimo-v2.6-flash-free").promptTokens).toBe(400);
  });

  it("sums per-model rows to exactly the provider total (nothing double counted)", async () => {
    await seed();
    const stats = await db.getUsageStats("all");

    const providerTotal = Object.values(stats.byProvider).reduce((s, p) => s + p.promptTokens, 0);
    const accountTotal = Object.values(stats.byAccount).reduce((s, a) => s + a.promptTokens, 0);

    expect(providerTotal).toBe(1000);
    expect(accountTotal).toBe(1000);
  });

  it("labels every row with the account it belongs to", async () => {
    await seed();
    const stats = await db.getUsageStats("all");

    for (const row of Object.values(stats.byAccount)) {
      expect(row.connectionId).toBe("acct-1");
      expect(row.accountName).toBeTruthy();
      expect(row.accountName).not.toContain("undefined");
    }
  });

  it("reads a legacy connectionId-keyed bucket without losing its model", async () => {
    // Pre-fix rows: bucket key is the bare connectionId, model lives only in meta.
    const { getAdapter } = await import("@/lib/db/driver.js");
    const adapter = await getAdapter();
    const legacy = {
      requests: 5, promptTokens: 500, completionTokens: 50, cost: 0, cachedTokens: 0,
      rawModel: "legacy-model", provider: "openai",
    };
    const dateKey = new Date().toISOString().slice(0, 10);
    adapter.run(
      `INSERT INTO usageDaily(dateKey, data) VALUES(?, ?) ON CONFLICT(dateKey) DO UPDATE SET data = excluded.data`,
      [dateKey, JSON.stringify({
        requests: 5, promptTokens: 500, completionTokens: 50, cost: 0, cachedTokens: 0,
        byProvider: { openai: legacy }, byModel: {}, byAccount: { legacyConn: legacy },
        byApiKey: {}, byEndpoint: {},
      })]
    );

    const stats = await db.getUsageStats("all");
    const rows = Object.values(stats.byAccount);
    expect(rows).toHaveLength(1);
    expect(rows[0].rawModel).toBe("legacy-model");
    expect(rows[0].connectionId).toBe("legacyConn");
    expect(rows[0].promptTokens).toBe(500);
  });
});

describe("usageDaily aggregate — secret hygiene", () => {
  it("never stores the raw API key in the daily aggregate", async () => {
    await seed();

    // The day rollup is coalesced in memory and written on a flush tick, so a
    // reader of the raw row must flush first (getUsageStats does this internally;
    // this test inspects the persisted blob directly).
    await db.flushDayRollup();

    const { getAdapter } = await import("@/lib/db/driver.js");
    const adapter = await getAdapter();
    const raw = adapter.get(`SELECT data FROM usageDaily`)?.data || "";

    expect(raw).not.toContain("sk-probe-key-000001");
    // The bucket id must still be present so per-key attribution survives.
    expect(raw).toContain("byApiKey");
  });
});
