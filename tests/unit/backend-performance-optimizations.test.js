// Test backend performance optimizations: batch aggregation and flush helpers.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-perf-"));
  process.env.DATA_DIR = tempDir;
  // Reset global singleton so each test gets fresh adapter pointed at tempDir
  delete global._dbAdapter;
  delete global._usageBatchWriteState;
  global._statsEmitter?.removeAllListeners?.();
  delete global._statsEmitter;
  vi.resetModules();
});

afterEach(() => {
  // Close adapter to release file handles before rm
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  delete global._usageBatchWriteState;
  global._statsEmitter?.removeAllListeners?.();
  delete global._statsEmitter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("Backend Performance Optimizations", () => {
  it("getRecentLogs() returns logs after saving and flushing usage", async () => {
    const db = await import("@/lib/db/index.js");
    const { __flushUsageBatchForTest } = await import("@/lib/db/repos/usageRepo.js");

    // Save a few usage entries
    await db.saveRequestUsage({
      provider: "openai",
      model: "gpt-4",
      connectionId: "conn-1",
      tokens: { prompt_tokens: 100, completion_tokens: 50 },
      endpoint: "/v1/chat/completions",
      status: "ok",
    });

    await db.saveRequestUsage({
      provider: "anthropic",
      model: "claude-3",
      connectionId: "conn-2",
      tokens: { prompt_tokens: 200, completion_tokens: 75 },
      endpoint: "/v1/messages",
      status: "ok",
    });

    await __flushUsageBatchForTest();

    // Get recent logs
    const logs = await db.getRecentLogs(10);

    expect(logs).toHaveLength(2);
    // Logs returned in DESC order (most recent first)
    expect(logs[0]).toContain("claude-3");
    expect(logs[0]).toContain("ANTHROPIC");
    expect(logs[1]).toContain("gpt-4");
    expect(logs[1]).toContain("OPENAI");
  });

  it("usageDaily totals aggregate correctly after batch flush", async () => {
    const db = await import("@/lib/db/index.js");
    const { __flushUsageBatchForTest } = await import("@/lib/db/repos/usageRepo.js");
    const { getAdapter } = await import("@/lib/db/driver.js");

    const timestamp = "2026-05-25T10:00:00.000Z";

    // Save 5 entries with same timestamp, each with prompt 10 completion 5
    for (let i = 0; i < 5; i++) {
      await db.saveRequestUsage({
        provider: "openai",
        model: "gpt-4",
        connectionId: `conn-${i}`,
        timestamp,
        tokens: { prompt_tokens: 10, completion_tokens: 5 },
        endpoint: "/v1/chat/completions",
        status: "ok",
      });
    }

    await __flushUsageBatchForTest();

    // Read usageDaily for 2026-05-25
    const adapter = await getAdapter();
    const dayRow = adapter.get(`SELECT data FROM usageDaily WHERE dateKey = ?`, ["2026-05-25"]);
    expect(dayRow).toBeDefined();

    const day = JSON.parse(dayRow.data);
    expect(day.requests).toBe(5);
    expect(day.promptTokens).toBe(50); // 5 entries * 10 tokens
    expect(day.completionTokens).toBe(25); // 5 entries * 5 tokens

    // Check totalRequestsLifetime
    const metaRow = adapter.get(`SELECT value FROM _meta WHERE key = ?`, ["totalRequestsLifetime"]);
    expect(metaRow).toBeDefined();
    expect(parseInt(metaRow.value, 10)).toBe(5);
  });

  it("requestDetails pruning with hysteresis respects maxRecords", async () => {
    // Set observability config for pruning test
    process.env.OBSERVABILITY_ENABLED = "true";
    process.env.OBSERVABILITY_MAX_RECORDS = "5";
    process.env.OBSERVABILITY_BATCH_SIZE = "2";

    // Reset modules to pick up env vars
    vi.resetModules();

    const db = await import("@/lib/db/index.js");
    const { __flushRequestDetailsForTest, __resetConfigCacheForTest } = db;
    const { getAdapter } = await import("@/lib/db/driver.js");
    const { updateSettings } = await import("@/lib/db/repos/settingsRepo.js");

    // Update settings to override defaults
    await updateSettings({
      observabilityMaxRecords: 5,
      observabilityBatchSize: 2,
    });

    // Reset config cache to pick up new settings
    __resetConfigCacheForTest();

    // Save 60 request details with increasing timestamps to exceed threshold
    for (let i = 0; i < 60; i++) {
      const timestamp = new Date(Date.now() + i * 1000).toISOString();
      await db.saveRequestDetail({
        provider: "openai",
        model: "gpt-4",
        connectionId: `conn-${i}`,
        timestamp,
        status: "ok",
      });
    }

    // Flush all pending writes
    await __flushRequestDetailsForTest();

    // Check count is <= maxRecords
    const adapter = await getAdapter();
    const result = adapter.get(`SELECT COUNT(*) as c FROM requestDetails`);
    expect(result.c).toBeLessThanOrEqual(5);

    // Cleanup env vars
    delete process.env.OBSERVABILITY_ENABLED;
    delete process.env.OBSERVABILITY_MAX_RECORDS;
    delete process.env.OBSERVABILITY_BATCH_SIZE;
  });
});
