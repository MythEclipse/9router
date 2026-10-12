// Benchmark: the SQLite layer on representative workloads.
// Run: cd app/tests && npm test -- db-benchmark
//
// This used to compare SQLite against lowdb. lowdb left the stack in the
// SQLite migration (src/lib/db/), so the comparison half was permanently
// unrunnable — the whole file failed collection on `import("lowdb")` and its
// cases were reported as 0 assertions, invisible to the regression gate. The
// SQLite numbers are the part worth keeping.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeAll, afterAll, vi } from "vitest";

const N_ITEMS = 500;
const N_QUERIES = 200;

const originalDataDir = process.env.DATA_DIR;
let tempSqlite;
let sqliteDb;

function fmt(ms) { return `${ms.toFixed(2)}ms`; }

async function bench(label, fn) {
  // warmup
  await fn();
  const t0 = performance.now();
  await fn();
  const dt = performance.now() - t0;
  console.log(`  ${label.padEnd(40)} ${fmt(dt)}`);
  return dt;
}

beforeAll(async () => {
  // SQLite setup
  tempSqlite = fs.mkdtempSync(path.join(os.tmpdir(), "9router-bench-sqlite-"));
  process.env.DATA_DIR = tempSqlite;
  vi.resetModules();
  sqliteDb = await import("@/lib/db/index.js");
  await sqliteDb.initDb();
});

afterAll(() => {
  if (tempSqlite) fs.rmSync(tempSqlite, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("DB Benchmark — SQLite", () => {
  it(`INSERT ${N_ITEMS} provider connections`, async () => {
    console.log(`\n[INSERT ${N_ITEMS}]`);

    const sqliteTime = await bench("SQLite createProviderConnection", async () => {
      for (let i = 0; i < N_ITEMS; i++) {
        await sqliteDb.createProviderConnection({
          provider: `bench-p${i % 5}`, authType: "apikey",
          name: `name-${i}`, apiKey: `k-${i}`,
        });
      }
    });

    console.log(`  → SQLite ${fmt(sqliteTime)}`);
  }, 60000);

  it(`READ ${N_QUERIES} filtered queries`, async () => {
    console.log(`\n[READ ${N_QUERIES} filtered queries]`);

    const sqliteTime = await bench("SQLite getProviderConnections(filter)", async () => {
      for (let i = 0; i < N_QUERIES; i++) {
        await sqliteDb.getProviderConnections({ provider: `bench-p${i % 5}` });
      }
    });


    console.log(`  → SQLite ${fmt(sqliteTime)}`);
  }, 60000);

  it(`READ ${N_QUERIES} by id (point lookup)`, async () => {
    console.log(`\n[READ ${N_QUERIES} by id]`);

    const sqliteAll = await sqliteDb.getProviderConnections();
    const ids = sqliteAll.slice(0, N_QUERIES).map((c) => c.id);

    const sqliteTime = await bench("SQLite getProviderConnectionById", async () => {
      for (const id of ids) await sqliteDb.getProviderConnectionById(id);
    });


    console.log(`  → SQLite ${fmt(sqliteTime)}`);
  }, 60000);

  it(`saveRequestUsage ${N_ITEMS} entries`, async () => {
    console.log(`\n[saveRequestUsage ${N_ITEMS}]`);

    const sqliteTime = await bench("SQLite saveRequestUsage", async () => {
      for (let i = 0; i < N_ITEMS; i++) {
        await sqliteDb.saveRequestUsage({
          provider: "openai", model: `m-${i % 10}`, connectionId: `c-${i % 5}`,
          tokens: { prompt_tokens: 100 + i, completion_tokens: 50 + i },
          endpoint: "/v1/chat/completions", status: "ok",
        });
      }
    });

    console.log(`  → SQLite ${fmt(sqliteTime)}`);
  }, 120000);

  it(`getUsageStats(24h) repeat 50x`, async () => {
    console.log(`\n[getUsageStats(24h) x 50]`);

    const sqliteTime = await bench("SQLite getUsageStats(24h)", async () => {
      for (let i = 0; i < 50; i++) await sqliteDb.getUsageStats("24h");
    });


    console.log(`  → SQLite ${fmt(sqliteTime)}`);
  }, 60000);
});
