// Guards the request-usage dedupe boundary.
//
// saveRequestUsage used to dedupe on timestamp+model+token-counts. Every caller
// stamps its own `new Date().toISOString()`, so two reports of the SAME request
// are always milliseconds apart and never matched — the guard protected nothing.
// Two DISTINCT requests that landed on the same millisecond with equal token
// counts (a burst of identical prompts on one key) matched, and one was dropped.
//
// It now keys on an explicit per-request id: a caller that can double-report
// supplies one, everything else inserts.
//
// NOTE: the data dir is resolved once at module load (src/lib/dataDir.js reads
// DATA_DIR on import), so per-case isolation by swapping env does NOT work here.
// Each case therefore measures the delta in lifetime request count instead.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { saveRequestUsage, getUsageStats } from "../../src/lib/db/index.js";

const originalDataDir = process.env.DATA_DIR;

function entry(overrides = {}) {
  return {
    provider: "probe-dedupe",
    model: "m1",
    connectionId: "c1",
    tokens: { prompt_tokens: 10, completion_tokens: 5 },
    status: "ok",
    apiKey: "sk-probe-key",
    ...overrides,
  };
}

async function countRequests() {
  const stats = await getUsageStats("today");
  return stats.totalRequests;
}

describe("usage dedupe — keyed on request identity, not wall clock", () => {
  beforeEach(() => {
    delete global._recentRing;
    delete global._pendingRequests;
    delete global._lastErrorProvider;
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    delete global._recentRing;
    delete global._pendingRequests;
    delete global._lastErrorProvider;
  });

  it("counts two distinct requests that share a timestamp and token counts", async () => {
    const before = await countRequests();

    // Same millisecond, same model, same key, same token counts — the exact
    // shape that used to collapse into a single row.
    const timestamp = new Date().toISOString();
    await saveRequestUsage(entry({ timestamp, requestId: "req-a" }));
    await saveRequestUsage(entry({ timestamp, requestId: "req-b" }));

    expect(await countRequests()).toBe(before + 2);
  });

  it("collapses a genuine double-report of one request id", async () => {
    const before = await countRequests();

    // A caller that reports the same request twice (a retried bookkeeping path,
    // not a retried upstream call) must not bill twice.
    await saveRequestUsage(entry({ timestamp: new Date().toISOString(), requestId: "req-dup" }));
    await saveRequestUsage(entry({ timestamp: new Date().toISOString(), requestId: "req-dup" }));

    expect(await countRequests()).toBe(before + 1);
  });

  it("keeps the legacy byte-identical dedupe for callers with no request id", async () => {
    // Untagged callers (image / embeddings / System One) must behave exactly as
    // they did before the requestId path existed: a byte-identical retry of the
    // same write is still one row.
    const before = await countRequests();

    const timestamp = new Date().toISOString();
    await saveRequestUsage(entry({ timestamp }));
    await saveRequestUsage(entry({ timestamp }));

    expect(await countRequests()).toBe(before + 1);
  });
});
