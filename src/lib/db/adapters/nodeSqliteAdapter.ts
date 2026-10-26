// Built-in node:sqlite adapter - available in Node >= 22.5.0.
// No native build, no npm install. API mirrors betterSqliteAdapter.
import { PRAGMA_SQL } from "../schema";
import type { ResolvedDbAdapter } from "../types";

const CHECKPOINT_INTERVAL_MS = 60 * 1000;

export async function createNodeSqliteAdapter(filePath: string): Promise<ResolvedDbAdapter> {
  // Suppress "ExperimentalWarning: SQLite is an experimental feature" from node:sqlite.
  // Stable enough for production use as of Node 22.x (RC quality).
  const origEmit = process.emit;
  // `process.emit` is heavily overloaded per event name; the filter only needs to
  // intercept `warning` and must stay transparent for every other event, so it is
  // typed against the base signature and forwarded unchanged.
  const filteredEmit = function (
    this: NodeJS.Process,
    name: string | symbol,
    data: unknown,
    ...rest: unknown[]
  ): boolean {
    if (
      name === "warning" &&
      typeof data === "object" &&
      data !== null &&
      (data as { name?: string }).name === "ExperimentalWarning" &&
      /SQLite/i.test(String((data as { message?: string }).message ?? ""))
    ) {
      return false;
    }
    return (origEmit as (...args: unknown[]) => boolean).call(this, name, data, ...rest);
  };
  process.emit = filteredEmit as typeof process.emit;

  // Dynamic import - fails on Node < 22.5 → driver.js falls back to sql.js
  const sqlite = await import("node:sqlite");
  const Database = sqlite.DatabaseSync;
  const db = new Database(filePath);

  db.exec(PRAGMA_SQL);

  const stmtCache = new Map();
  function prepare(sql) {
    let stmt = stmtCache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  // Transaction primitives for `transaction()` below. Prepared once here; the
  // statements are name-parameterised by depth (0 = outermost).
  const TX_MAX_DEPTH = 16;
  let txDepth = 0;
  const txSavepointStmts = [];
  const txReleaseStmts = [];
  const txRollbackStmts = [];
  for (let i = 0; i < TX_MAX_DEPTH; i++) {
    txSavepointStmts.push(db.prepare(`SAVEPOINT sp_${i}`));
    txReleaseStmts.push(db.prepare(`RELEASE sp_${i}`));
    txRollbackStmts.push(db.prepare(`ROLLBACK TO sp_${i}`));
  }

  // Overflows past TX_MAX_DEPTH (16 nested) fall back to a one-off exec rather
  // than failing: nest depth is a perf detail, not a correctness condition.
  const txSavepoint = (d) => (txSavepointStmts[d] || { run: () => db.exec(`SAVEPOINT sp_${d}`) }).run();
  const txRelease = (d) => (txReleaseStmts[d] || { run: () => db.exec(`RELEASE sp_${d}`) }).run();
  const txRollbackTo = (d) => (txRollbackStmts[d] || { run: () => db.exec(`ROLLBACK TO sp_${d}`) }).run();

  // Periodic WAL checkpoint to keep -wal/-shm small
  const checkpointTimer = setInterval(() => {
    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
  }, CHECKPOINT_INTERVAL_MS);
  if (typeof checkpointTimer.unref === "function") checkpointTimer.unref();

  function gracefulClose() {
    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
    try { stmtCache.clear(); } catch {}
    try { db.close(); } catch {}
  }
  const onShutdown = () => gracefulClose();
  const onSigint = () => { onShutdown(); process.exit(0); };
  const onSigterm = () => { onShutdown(); process.exit(0); };
  process.once("beforeExit", onShutdown);
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  // Detach this adapter's process handlers. Without this, every adapter built in
  // one process (each test file boots one, and a dev HMR pass rebuilds it) left
  // three listeners behind for good: Node starts warning about a 10-listener
  // leak and every stale copy keeps a closed database alive to flush it.
  function detachShutdownHandlers() {
    process.off("beforeExit", onShutdown);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }

  return {
    driver: "node:sqlite",
    run(sql, params = []) {
      const r = prepare(sql).run(...params);
      return { changes: Number(r.changes ?? 0), lastInsertRowid: Number(r.lastInsertRowid ?? 0) };
    },
    get(sql, params = []) {
      return prepare(sql).get(...params);
    },
    all(sql, params = []) {
      return prepare(sql).all(...params);
    },
    exec(sql) { return db.exec(sql); },
    transaction(fn) {
      // node:sqlite has no transaction wrapper. Use SAVEPOINT for nested support.
      //
      // Both statements are prepared once and the name comes from a depth
      // counter, not `Math.random()`. Measured per begin+commit pair on this
      // driver: random name via exec 1.83us, fixed name via exec 1.37us, prepared
      // 0.86us. This runs twice per completed request (the PENDING marker and the
      // usage row), so it is on the hot path.
      //
      // The depth counter keeps names unique per nesting level, which is all
      // SAVEPOINT needs — it is not a connection-shared namespace across
      // concurrent writers, because this driver is synchronous and a transaction
      // cannot interleave with another.
      const depth = txDepth++;
      try {
        txSavepoint(depth);
        const r = fn();
        txRelease(depth);
        return r;
      } catch (e) {
        try {
          txRollbackTo(depth);
          txRelease(depth);
        } catch { /* the original error is the one worth surfacing */ }
        throw e;
      } finally {
        txDepth--;
      }
    },
    checkpoint() { try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {} },
    close() {
      clearInterval(checkpointTimer);
      detachShutdownHandlers();
      gracefulClose();
    },
    raw: db,
  };
}
