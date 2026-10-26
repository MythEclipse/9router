// Regression: the Request Logs tab reads usageHistory back as " | "-joined
// strings and classifies each row's status cell by substring — "PENDING" pulses,
// "FAILED" is red, "OK" is green. Two defects met in that contract:
//
//   1. saveRequestUsage writes the wire-style "ok"/"error", so EVERY successful
//      request fell through all three checks and rendered as a pulsing PENDING
//      row — a finished request looked permanently in flight.
//   2. appendRequestLog was a no-op, so the FAILED rows callers report on every
//      error path were never written at all. The tab showed only successes, with
//      no trace of what broke.
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-reqlog-"));
  process.env.DATA_DIR = tempDir;
  // Adapter/ring state lives on `global` (Next.js hot-reload survival), so
  // vi.resetModules() alone would keep using the previous test's database.
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

afterEach(() => {
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

// What RequestLogger.js does to a log line.
const classify = (line) => {
  const parts = line.split(" | ");
  const status = parts[parts.length - 1];
  if (status.includes("PENDING")) return "pending";
  if (status.includes("FAILED")) return "failed";
  if (status.includes("OK")) return "success";
  return "unclassified";
};

describe("request log — status vocabulary matches the reader", () => {
  it("renders a successful request as success, not as a pending row", async () => {
    await db.saveRequestUsage({
      provider: "opencode", model: "beam-free", connectionId: "acct-1",
      tokens: { prompt_tokens: 10, completion_tokens: 2 },
      endpoint: "/v1/chat/completions", status: "ok",
    });

    const logs = await db.getRecentLogs(10);
    expect(logs).toHaveLength(1);
    expect(classify(logs[0])).toBe("success");
  });

  it("renders a recorded failure as failed", async () => {
    await db.appendRequestLog({
      model: "beam-free", provider: "opencode",
      connectionId: "acct-1", status: "FAILED 400",
    });

    const logs = await db.getRecentLogs(10);
    expect(logs).toHaveLength(1);
    expect(classify(logs[0])).toBe("failed");
  });

  it("keeps an explicit PENDING row pending", async () => {
    await db.appendRequestLog({ model: "beam-free", provider: "opencode", status: "PENDING" });

    const logs = await db.getRecentLogs(10);
    expect(logs).toHaveLength(1);
    expect(classify(logs[0])).toBe("pending");
  });

  it("does not record non-failure statuses (successes own that path)", async () => {
    await db.appendRequestLog({ model: "beam-free", provider: "opencode", status: "200 OK" });

    expect(await db.getRecentLogs(10)).toHaveLength(0);
  });
});

describe("request log — failures are visible next to successes", () => {
  it("lists failures and successes together, newest first", async () => {
    const now = Date.now();
    await db.saveRequestUsage({
      provider: "opencode", model: "beam-free", connectionId: "acct-1",
      tokens: { prompt_tokens: 100, completion_tokens: 20 },
      endpoint: "/v1/chat/completions", status: "ok",
      timestamp: new Date(now - 5000).toISOString(),
    });
    await db.appendRequestLog({
      model: "union-alpha", provider: "opencode",
      connectionId: "acct-1", status: "FAILED 410",
    });

    const logs = await db.getRecentLogs(10);
    expect(logs).toHaveLength(2);

    const kinds = logs.map(classify);
    expect(kinds).toContain("success");
    expect(kinds).toContain("failed");

    // The failure is the most recent write, so it sorts first.
    expect(classify(logs[0])).toBe("failed");
    expect(logs[0]).toContain("union-alpha");
  });
});

describe("request log — lifecycle rows are not usage", () => {
  it("keeps failures and pending markers out of usage totals", async () => {
    await db.saveRequestUsage({
      provider: "opencode", model: "beam-free", connectionId: "acct-1",
      tokens: { prompt_tokens: 100, completion_tokens: 20 },
      endpoint: "/v1/chat/completions", status: "ok",
    });
    await db.appendRequestLog({ model: "union-alpha", provider: "opencode", connectionId: "acct-1", status: "FAILED 400" });
    await db.appendRequestLog({ model: "union-alpha", provider: "opencode", connectionId: "acct-1", status: "PENDING" });

    // Two requests were made, but only one was billed.
    const stats = await db.getUsageStats("24h");
    expect(stats.totalRequests).toBe(1);
    expect(stats.totalPromptTokens).toBe(100);
    expect(Object.keys(stats.byProvider)).toEqual(["opencode"]);
    // The failed model must not appear as a zero-token usage row.
    expect(Object.values(stats.byAccount).map((r) => r.rawModel)).toEqual(["beam-free"]);

    // ...while the log still shows all three events.
    expect(await db.getRecentLogs(10)).toHaveLength(3);
  });

  it("keeps lifecycle rows out of the chart series too", async () => {
    await db.saveRequestUsage({
      provider: "opencode", model: "beam-free", connectionId: "acct-1",
      tokens: { prompt_tokens: 100, completion_tokens: 20 },
      endpoint: "/v1/chat/completions", status: "ok",
    });
    await db.appendRequestLog({ model: "union-alpha", provider: "opencode", connectionId: "acct-1", status: "FAILED 500" });

    const chart = await db.getChartData("24h");
    const requests = chart.reduce((s, b) => s + b.requests, 0);
    const tokens = chart.reduce((s, b) => s + b.tokens, 0);
    expect(requests).toBe(1);
    expect(tokens).toBe(120);
  });
});
