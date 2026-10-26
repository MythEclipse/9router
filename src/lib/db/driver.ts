import { ensureDirs, DATA_FILE } from "./paths";
import { stripNullBytes } from "./helpers/nullBytes";
import type { DbParams, ResolvedDbAdapter } from "./types";

export type { DbDriverName, ResolvedDbAdapter } from "./types";

interface DbDriverState {
  instance: ResolvedDbAdapter | null;
  initPromise: Promise<ResolvedDbAdapter> | null;
  logged: boolean;
}

// Use global to survive Next.js dev hot-reload (module state resets on reload)
declare global {
  var _dbAdapter: DbDriverState | undefined;
}
if (!global._dbAdapter) global._dbAdapter = { instance: null, initPromise: null, logged: false };
const state = global._dbAdapter;

async function tryBunSqlite() {
  // Bun runtime only - built-in, no install needed
  if (!process.versions.bun) return null;
  try {
    const { createBunSqliteAdapter } = await import("./adapters/bunSqliteAdapter");
    return await createBunSqliteAdapter(DATA_FILE);
  } catch (e) {
    console.warn(`[DB] bun:sqlite unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function tryBetterSqlite() {
  // Skip on Bun - better-sqlite3 native bindings unsupported
  if (process.versions.bun) return null;
  // Skip on Node >= 24: the native addon SIGSEGVs on load there, which is a
  // process-level crash the try/catch below cannot recover from. node:sqlite covers it.
  const [nodeMajor] = process.versions.node.split(".").map(Number);
  if (nodeMajor >= 24) return null;
  try {
    const { createBetterSqliteAdapter } = await import("./adapters/betterSqliteAdapter");
    return createBetterSqliteAdapter(DATA_FILE);
  } catch (e) {
    console.warn(`[DB] better-sqlite3 unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function tryNodeSqlite() {
  // Built-in since Node 22.5.0 - no install needed. Skip under Bun (no node:sqlite).
  if (process.versions.bun) return null;
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 5)) return null;
  try {
    const { createNodeSqliteAdapter } = await import("./adapters/nodeSqliteAdapter");
    return await createNodeSqliteAdapter(DATA_FILE);
  } catch (e) {
    console.warn(`[DB] node:sqlite unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function trySqlJs() {
  try {
    const { createSqlJsAdapter } = await import("./adapters/sqljsAdapter");
    return await createSqlJsAdapter(DATA_FILE);
  } catch (e) {
    console.warn(`[DB] sql.js unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * Make every bound string NUL-safe, once, for all drivers.
 *
 * SQLite stores TEXT as a NUL-terminated C string, so a bound string with an
 * embedded NUL is rejected by better-sqlite3 ("String contains null byte") and
 * silently truncated by node:sqlite. Values that carry raw bytes — a model id
 * or endpoint from the request, tool output, a diff — can contain one, and the
 * write then either aborts the flush worker or loses the tail without a
 * trace. Sanitising at the binding boundary covers every driver and every
 * column type with a single rule, instead of one call site at a time.
 *
 * @param {object} adapter
 * @returns {object} adapter with NUL-safe run/get/all
 */
function withNullByteSafeParams(adapter: ResolvedDbAdapter): ResolvedDbAdapter {
  const clean = (params?: DbParams): DbParams | undefined =>
    Array.isArray(params) ? params.map(stripNullBytes) : params;
  return {
    ...adapter,
    run: (sql: string, params?: DbParams) => adapter.run(sql, clean(params)),
    get: <T,>(sql: string, params?: DbParams) => adapter.get<T>(sql, clean(params)),
    all: <T,>(sql: string, params?: DbParams) => adapter.all<T>(sql, clean(params)),
  };
}

async function initAdapter(): Promise<ResolvedDbAdapter> {
  ensureDirs();
  // Order per runtime:
  //   Bun:  bun:sqlite → sql.js
  //   Node: better-sqlite3 → node:sqlite (≥22.5) → sql.js
  let adapter = await tryBunSqlite();
  if (!adapter) adapter = await tryBetterSqlite();
  if (!adapter) adapter = await tryNodeSqlite();
  if (!adapter) adapter = await trySqlJs();
  if (!adapter)
    throw new Error("[DB] No SQLite driver available (bun/better/node/sql.js all failed)");

  adapter = withNullByteSafeParams(adapter);

  adapter = withNullByteSafeParams(adapter);

  if (!state.logged) {
    console.log(`[DB] Driver: ${adapter.driver} | file: ${DATA_FILE}`);
    state.logged = true;
  }

  const { runMigrationOnce } = await import("./migrate");
  await runMigrationOnce(adapter);
  return adapter;
}

export async function getAdapter(): Promise<ResolvedDbAdapter> {
  if (state.instance) return state.instance;
  if (!state.initPromise)
    state.initPromise = initAdapter().then((a) => {
      state.instance = a;
      return a;
    });
  return state.initPromise;
}

export async function closeDb() {
  if (state.instance) {
    if (state.instance.close) state.instance.close();
    state.instance = null;
    state.initPromise = null;
  }
}
