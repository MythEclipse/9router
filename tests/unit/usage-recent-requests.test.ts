import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir;
let db;
const originalDataDir = process.env.DATA_DIR;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-recent-requests-"));
  process.env.DATA_DIR = tempDir;
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

describe("recent requests", () => {
  it("keeps distinct same-model requests with identical token counts", async () => {
    const timestamp = new Date().toISOString();
    const base = {
      provider: "codex",
      model: "gpt-5.6-sol",
      connectionId: "codex-account",
      apiKey: "sk-recent-requests-test",
      timestamp,
      tokens: { prompt_tokens: 7411, completion_tokens: 19 },
      status: "ok",
    };

    await db.saveRequestUsage({ ...base, requestId: "codex-request-1" });
    await db.saveRequestUsage({ ...base, requestId: "codex-request-2" });

    const [active, stats] = await Promise.all([
      db.getActiveRequests(),
      db.getUsageStats("today"),
    ]);

    expect(active.recentRequests).toHaveLength(2);
    expect(stats.recentRequests).toHaveLength(2);
    expect(active.recentRequests.map((request) => request.model)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-sol",
    ]);
  });
});
