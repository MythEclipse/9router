import { describe, it, expect, beforeEach, vi } from "vitest";

// The PENDING marker carries the request's id so the terminal usage write can
// close it with an indexed lookup. The danger is the other direction: an ERROR
// row that also carried the id would be found by saveRequestUsage's requestId
// dedupe and swallow the usage row written later for the same request.
describe("usage PENDING marker / request id", () => {
  beforeEach(async () => {
    vi.resetModules();
    // Global singletons survive resetModules; DATA_DIR is restored by the setup
    // file, so only the caches are dropped here.
    delete global._dbAdapter;
    delete global._recent;
    delete global._pendingRequests;
  });

  async function freshDb() {
    const db = await import("@/lib/db/index.js");
    const driver = await import("@/lib/db/driver.js");
    const adapter = await driver.getAdapter();
    adapter.exec("DELETE FROM usageHistory");
    return { db, adapter };
  }

  it("closes the pending marker when the usage row lands", async () => {
    const { db, adapter } = await freshDb();
    const requestId = "req-marker-1";

    await db.appendRequestLog({
      provider: "opencode", model: "beam-free", connectionId: "acct-1",
      status: "PENDING", requestId,
    });

    let rows = adapter.all("SELECT status, requestId FROM usageHistory ORDER BY id");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].requestId).toBe(requestId);

    await db.saveRequestUsage({
      provider: "opencode", model: "beam-free", connectionId: "acct-1",
      tokens: { prompt_tokens: 10, completion_tokens: 5 },
      endpoint: "/v1/chat/completions", requestId,
    });

    rows = adapter.all("SELECT status, requestId FROM usageHistory ORDER BY id");
    // One row, not two: the marker was superseded, and the usage row survived
    // the dedupe because the marker is gone by then.
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("ok");
  });

  it("does not tag an ERROR row with the request id (it would suppress the usage row)", async () => {
    const { db, adapter } = await freshDb();
    const requestId = "req-marker-2";

    await db.appendRequestLog({
      provider: "opencode", model: "beam-free", connectionId: "acct-1",
      status: "FAILED 429", requestId,
    });

    expect(adapter.get("SELECT requestId FROM usageHistory")?.requestId).toBeNull();

    // A retry on the same request still gets its usage row.
    await db.saveRequestUsage({
      provider: "opencode", model: "beam-free", connectionId: "acct-1",
      tokens: { prompt_tokens: 10, completion_tokens: 5 },
      endpoint: "/v1/chat/completions", requestId,
    });

    const ok = adapter.get("SELECT COUNT(*) AS n FROM usageHistory WHERE status = 'ok'");
    expect(ok.n).toBe(1);
  });

  it("still closes an untagged pending marker (legacy path keeps working)", async () => {
    const { db, adapter } = await freshDb();

    await db.appendRequestLog({
      provider: "opencode", model: "beam-free", connectionId: "acct-1",
      status: "PENDING",
    });
    await db.saveRequestUsage({
      provider: "opencode", model: "beam-free", connectionId: "acct-1",
      tokens: { prompt_tokens: 4, completion_tokens: 2 },
      endpoint: "/v1/chat/completions",
    });

    expect(adapter.get("SELECT COUNT(*) AS n FROM usageHistory")?.n).toBe(1);
  });

  it("deletes the marker by requestId without scanning the table", async () => {
    await freshDb();

    const driver = await import("@/lib/db/driver.js");
    const adapter = await driver.getAdapter();

    const plan = adapter.all(
      "EXPLAIN QUERY PLAN DELETE FROM usageHistory WHERE requestId = ? AND status = 'pending'",
      ["x"]
    );
    const text = plan.map((r) => r.detail).join(" ");
    // SQLite reports either a plain index seek or a search over the index.
    expect(text.toLowerCase()).toMatch(/index|requestid/);
    expect(text.toLowerCase()).not.toMatch(/scan usagehistory/);
  });
});
