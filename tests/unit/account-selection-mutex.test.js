// Account selection used to serialise EVERY provider behind one process-wide
// mutex promise chain. That is invisible under fill-first (selection is
// read-only), but round-robin writes the chosen account's lastUsedAt and
// consecutiveUseCount inside the critical section, so with one provider on
// round-robin every other provider's selection queued behind that DB write.
//
// The lock is now per provider: an account belongs to exactly one provider, and
// the strategy / sticky limit are read per provider, so cross-provider ordering
// never mattered. These tests pin the two properties that must hold:
//   • different providers select concurrently (no shared queue), and
//   • selections OF THE SAME provider still serialise (no lost rotation state).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
let db;
const originalDataDir = process.env.DATA_DIR;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-selection-mutex-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  delete global._pendingRequests;
  delete global._connectionMapCache;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();

  const now = new Date().toISOString();
  for (const provider of ["prova", "provb"]) {
    for (let i = 0; i < 4; i++) {
      await db.createProviderConnection({
        id: `${provider}-${i}`,
        provider,
        authType: "apikey",
        name: `${provider} ${i}`,
        apiKey: `key-${provider}-${i}`,
        priority: i + 1,
        isActive: true,
        testStatus: "active",
        createdAt: now,
        updatedAt: now,
      });
    }
  }
  // Round-robin on BOTH providers: this is the writing path, so it is the one
  // that could actually serialise if the lock were shared.
  await db.updateSettings({
    fallbackStrategy: "round-robin",
    stickyRoundRobinLimit: 1,
  });
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  try { global._dbAdapter?.instance?.close?.(); } catch { /* already closed */ }
  delete global._dbAdapter;
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("account selection mutex is per provider", () => {
  it("selects across two providers concurrently, not serially", async () => {
    const { getProviderCredentials } = await import("../../src/sse/services/auth.js");

    // Warm both providers so alias/credential caches are populated.
    await getProviderCredentials("prova", new Set(), "m1", {});
    await getProviderCredentials("provb", new Set(), "m1", {});

    const N = 12;

    // Sequential reference: N selections of prova, one after another.
    const tSeq = process.hrtime.bigint();
    for (let i = 0; i < N; i++) await getProviderCredentials("prova", new Set(), "m1", {});
    const seqMs = Number(process.hrtime.bigint() - tSeq) / 1e6;

    // The same N selections on prova, but with N selections of provb running at
    // the same time. A SHARED lock would serialise all 2N (so this wall time
    // would be ≈ 2× the sequential run); per-provider locks let the two
    // providers progress in parallel (≈ 1× plus overhead).
    const tPar = process.hrtime.bigint();
    await Promise.all([
      ...Array.from({ length: N }, () => getProviderCredentials("prova", new Set(), "m1", {})),
      ...Array.from({ length: N }, () => getProviderCredentials("provb", new Set(), "m1", {})),
    ]);
    const parMs = Number(process.hrtime.bigint() - tPar) / 1e6;

    // Generous bound: fails clearly if a shared queue comes back (≈2×), tolerant
    // of scheduler noise on a loaded machine.
    expect(parMs).toBeLessThan(seqMs * 1.8);
  });

  it("still serialises selections of the SAME provider (rotation state is consistent)", async () => {
    const { getProviderCredentials } = await import("../../src/sse/services/auth.js");

    // 8 concurrent selections on one provider with sticky limit 1: round-robin
    // must spread them across the 4 accounts, which only holds if the critical
    // section never interleaves (each selection reads the state the previous one
    // wrote).
    const picked = await Promise.all(
      Array.from({ length: 8 }, () => getProviderCredentials("prova", new Set(), "m1", {}))
    );

    const ids = picked.map((c) => c?.connectionId).filter(Boolean);
    expect(ids).toHaveLength(8);
    // Every account gets used: a corrupted/interleaved rotation would skew onto
    // one or two accounts and leave others untouched.
    expect(new Set(ids).size).toBe(4);
  });
});
