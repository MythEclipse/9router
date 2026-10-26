/**
 * Shared persistence types.
 *
 * The repos hand `unknown` JSON columns and adapter rows around constantly.
 * Naming the adapter surface and the JSON helpers here is what lets a repo
 * declare `parseJson<UsageDay>(row.data, {})` instead of falling back to
 * `unknown` at every property access.
 */

/** A row as returned by any adapter - columns are dynamic by nature. */
export type DbRow = Record<string, unknown>;

/** Positional or named parameters accepted by every adapter. */
export type DbParams = unknown[];

/** What `run()` reports back, normalized across drivers. */
export interface DbRunResult {
  changes: number;
  lastInsertRowid: number;
}

/**
 * The query surface every adapter (bun/better/node/sql.js) provides.
 *
 * `get`/`all` are generic with a `DbRow` default: a repo that has a precise row
 * shape passes it through (`db.all<UsageRow>(…)`), and one that does not gets
 * `Record<string, unknown>` instead of `any`.
 */
export interface DbAdapter {
  /** Driver name, surfaced in the startup log and diagnostics. */
  driver?: string;
  all<T = DbRow>(sql: string, params?: DbParams): T[];
  get<T = DbRow>(sql: string, params?: DbParams): T | undefined;
  run(sql: string, params?: DbParams): DbRunResult;
  exec(sql: string): unknown;
  close(): void;
  /** Adapters that support transactions expose this. */
  transaction<T>(fn: () => T): T;
  /** WAL checkpoint; absent on sql.js (in-memory). */
  checkpoint(): void;
  /** The underlying driver handle, for driver-specific escape hatches. */
  raw?: unknown;
}

/** Driver name, for the startup log line and diagnostics. */
export type DbDriverName = "bun:sqlite" | "better-sqlite3" | "node:sqlite" | "sql.js";

/** A concrete adapter as returned by the per-runtime factories. */
export type ResolvedDbAdapter = DbAdapter & { driver: DbDriverName | string };

/** A row whose `data`/`meta` columns hold JSON we are about to parse. */
export interface JsonColumnRow extends DbRow {
  data?: string | null;
  meta?: string | null;
}

/** Per-provider usage counters as stored in daily summaries. */
export interface ProviderUsageCounters {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cost: number;
  rawModel?: string;
  provider?: string;
  resolvedModel?: string;
  lastUsed?: string;
  [key: string]: unknown;
}

/** A daily usage summary blob (`usageDailySummary.data`). */
export interface UsageDaySummary {
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  cost?: number;
  byProvider?: Record<string, ProviderUsageCounters>;
  byModel?: Record<string, ProviderUsageCounters>;
  byEndpoint?: Record<string, ProviderUsageCounters>;
  byApiKey?: Record<string, { lastUsed?: string; requests?: number; [key: string]: unknown }>;
  [key: string]: unknown;
}
