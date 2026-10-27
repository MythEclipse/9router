import { EventEmitter } from "events";
import { createHash } from "crypto";
import { getAdapter } from "../driver";
import type { DbRow, ResolvedDbAdapter } from "../types";
import { parseJson, stringifyJson } from "../helpers/jsonCol";
import { getMeta, setMeta } from "../helpers/metaStore";

import { matchesAllowedModels as matchesModelPatterns, parseAllowedModels } from "./apiKeysRepo";

/** Token counts as they arrive from an upstream: several spellings coexist. */
export interface UsageTokens {
  prompt_tokens?: number;
  input_tokens?: number;
  completion_tokens?: number;
  output_tokens?: number;
  cached_tokens?: number;
  cache_read_input_tokens?: number;
  [key: string]: number | undefined;
}

/** One finished (or lifecycle) request, as the write path receives it. */
export interface UsageEntry {
  provider?: string | null;
  model?: string | null;
  resolvedModel?: string | null;
  connectionId?: string | null;
  apiKey?: string | null;
  endpoint?: string | null;
  timestamp?: string;
  cost?: number;
  status?: string | null;
  tokens?: UsageTokens | null;
  /** What the caller asked for, when routing rewrote the model. */
  requestedModel?: string | null;
  /** Correlation id for the log row; see the dedupe note in saveRequestUsage. */
  requestId?: string | number | null;
  [key: string]: unknown;
}

/** Counters kept per bucket (provider/model/account/key/endpoint). */
export interface UsageCounter {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cost: number;
  rawModel?: string | null;
  provider?: string | null;
  resolvedModel?: string | null;
  apiKey?: string | null;
  endpoint?: string | null;
  [key: string]: unknown;
}

/** One bucket collection keyed by an arbitrary composite key. */
export type UsageCounters = Record<string, UsageCounter>;

/** The per-day aggregate stored as one JSON blob in `usageDaily`. */
export interface UsageDay {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  cachedTokens?: number;
  byProvider?: UsageCounters;
  byModel?: UsageCounters;
  byAccount?: UsageCounters;
  byApiKey?: UsageCounters;
  byEndpoint?: UsageCounters;
  [key: string]: unknown;
}


function maskApiKey(key: unknown): string | null {
  if (!key || typeof key !== "string") return null;
  const trimmed = key.trim();
  if (trimmed.length <= 12) return trimmed.charAt(0) + "***";
  // Keep the tail: keys sharing a machine-id prefix (team keys) must not collide.
  return trimmed.slice(0, 8) + "***" + trimmed.slice(-4);
}

/**
 * Stable, non-reversible bucket id for a raw api key.
 *
 * `byApiKey` is keyed by raw api key (fix(usage) 4a57df8b) because keys minted
 * from the same machine id share their first 8 characters, so maskApiKey alone
 * collapsed every key of an instance into one bucket. But byApiKey is returned
 * verbatim by GET /api/usage/stats, so a raw key as a JSON *object key* leaks
 * the secret to any authenticated dashboard reader — the exact exposure
 * AUDIT-002 (#1962) closed.
 *
 * A digest keeps buckets distinct while putting nothing reversible on the wire.
 * SHA-256 over the raw key, truncated to 16 hex chars: collision-free for any
 * realistic key count, and the digest cannot be replayed against any upstream.
 */
function apiKeyBucketId(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

const PENDING_TIMEOUT_MS = 60 * 1000;
const RING_CAP = 50;
const CONN_CACHE_TTL_MS = 30 * 1000;
const PERIOD_MS = { "24h": 86400000, "7d": 604800000, "30d": 2592000000, "60d": 5184000000 };

// In-memory state shared across Next.js modules
if (!global._pendingRequests) global._pendingRequests = { byModel: {}, byAccount: {} };
if (!global._lastErrorProvider) global._lastErrorProvider = { provider: "", ts: 0 };
if (!global._statsEmitter) {
  global._statsEmitter = new EventEmitter();
  global._statsEmitter.setMaxListeners(50);
}
if (!global._pendingTimers) global._pendingTimers = {};
if (!global._recentRing) global._recentRing = { items: [], initialized: false };
if (!global._connectionMapCache) global._connectionMapCache = { map: {}, ts: 0 };
if (!global._statsEmitTimers) global._statsEmitTimers = { pending: null, update: null };

/** Live request counters, keyed by composed model label and by account. */
interface PendingRequests {
  byModel: Record<string, number>;
  byAccount: Record<string, Record<string, number>>;
}

const pendingRequests = global._pendingRequests as PendingRequests;
const lastErrorProvider = global._lastErrorProvider as { provider: string; ts: number };
const pendingTimers = global._pendingTimers as Record<string, NodeJS.Timeout | undefined>;
const recentRing = global._recentRing as { items: UsageEntry[]; initialized: boolean };
const connCache = global._connectionMapCache as { map: ConnectionMap; ts: number };
const statsEmitTimers = global._statsEmitTimers as {
  pending: NodeJS.Timeout | null;
  update: NodeJS.Timeout | null;
};

export const statsEmitter = global._statsEmitter as EventEmitter;

function scheduleStatsEvent(event: string, delayMs = 150): void {
  const key = event === "update" ? "update" : "pending";
  if (statsEmitTimers[key]) return;
  statsEmitTimers[key] = setTimeout(() => {
    statsEmitTimers[key] = null;
    statsEmitter.emit(event);
  }, delayMs);
  statsEmitTimers[key]?.unref?.();
}

function getLocalDateKey(timestamp?: string | number | null): string {
  const d = timestamp ? new Date(timestamp) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addToCounter(
  target: UsageCounters,
  key: string,
  values: { requests?: number; promptTokens?: number; completionTokens?: number; cachedTokens?: number; cost?: number; meta?: Record<string, unknown> }
): void {
  target[key] ||= { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
  target[key].requests += values.requests || 1;
  target[key].promptTokens += values.promptTokens || 0;
  target[key].completionTokens += values.completionTokens || 0;
  target[key].cachedTokens += values.cachedTokens || 0;
  target[key].cost += values.cost || 0;
   if (values.meta) {
    const meta: Record<string, unknown> = { ...values.meta };
    for (const k of Object.keys(meta)) if (meta[k] === undefined) delete meta[k];
    Object.assign(target[key], meta);
  }
}

function aggregateEntryToDay(day: UsageDay, entry: UsageEntry): void {
  const promptTokens = entry.tokens?.prompt_tokens || entry.tokens?.input_tokens || 0;
  const completionTokens = entry.tokens?.completion_tokens || entry.tokens?.output_tokens || 0;
  const cachedTokens = entry.tokens?.cached_tokens || entry.tokens?.cache_read_input_tokens || 0;
  const cost = entry.cost || 0;
  const vals = { promptTokens, completionTokens, cachedTokens, cost };

  day.requests = (day.requests || 0) + 1;
  day.promptTokens = (day.promptTokens || 0) + promptTokens;
  day.completionTokens = (day.completionTokens || 0) + completionTokens;
  day.cachedTokens = (day.cachedTokens || 0) + cachedTokens;
  day.cost = (day.cost || 0) + cost;

  day.byProvider ||= {};
  day.byModel ||= {};
  day.byAccount ||= {};
  day.byApiKey ||= {};
  day.byEndpoint ||= {};

  if (entry.provider) addToCounter(day.byProvider, entry.provider, vals);

  const modelKey = entry.provider ? `${String(entry.model)}|${entry.provider}` : String(entry.model);
  addToCounter(day.byModel, modelKey, { ...vals, meta: { rawModel: entry.model, provider: entry.provider, resolvedModel: entry.resolvedModel } });

  if (entry.connectionId) {
    // Keyed by the model as well as the account: an account's usage is reported
    // per model (the dashboard groups these rows by accountName), so collapsing
    // every model into one bucket per account reported the whole account under
    // whichever model happened to write last, with all other models' tokens
    // counted inside it. Meta carries rawModel/provider for the reader.
    const accountKey = `${entry.connectionId}|${String(entry.model)}|${entry.provider || "unknown"}`;
    addToCounter(day.byAccount, accountKey, { ...vals, meta: { rawModel: entry.model, provider: entry.provider } });
  }

  const apiKeyVal: string =
    entry.apiKey && typeof entry.apiKey === "string" ? entry.apiKey : "local-no-key";
  const akModelKey = `${apiKeyBucketId(String(apiKeyVal))}|${String(entry.model)}|${entry.provider || "unknown"}`;
  // `apiKey` here must stay the MASKED form. usageDaily is a persisted,
  // long-lived aggregate, and byApiKey is returned verbatim by
  // GET /api/usage/stats — storing the raw secret put a replayable upstream key
  // on disk and (via the reader's `ak.apiKey` passthrough) on the wire, which is
  // the exposure apiKeyBucketId exists to prevent. The bucket id keeps
  // attribution; the reader resolves names from it.
  addToCounter(day.byApiKey, akModelKey, { ...vals, meta: { rawModel: entry.model, provider: entry.provider, apiKey: maskApiKey(apiKeyVal) } });

  const endpoint = entry.endpoint || "Unknown";
  const epKey = `${endpoint}|${String(entry.model)}|${entry.provider || "unknown"}`;
  addToCounter(day.byEndpoint, epKey, { ...vals, meta: { endpoint, rawModel: entry.model, provider: entry.provider } });
}

function pushToRing(entry: UsageEntry): void {
  recentRing.items.push(entry);
  if (recentRing.items.length > RING_CAP) {
    recentRing.items = recentRing.items.slice(-RING_CAP);
  }
}

// ─── Coalesced day-rollup writer ─────────────────────────────────────────────
//
// `usageDaily` is one JSON blob per day, and the write path used to do a full
// read → JSON.parse → mutate → JSON.stringify → UPSERT for EVERY completed
// request. That is O(blob) per request on a synchronous driver that blocks the
// event loop, so the cost grows with how busy the day was: measured on this
// repo, 245us/request on an empty day but 2.4ms at 210KB and 10.9ms at 1MB
// (parse 24ms + stringify 20ms per write at 4MB). With many concurrent users
// that one hotspot serialises the whole gateway.
//
// Fix: a finished request appends its contribution to `usagePending` — one small
// INSERT, O(1) regardless of how large the day already is — and the blob is
// rewritten once per flush, with every pending row folded in at that point.
//
// This is deliberately NOT an in-memory buffer. Buffering would make the write
// cheap but lose the pending window on every restart, and the gateway is
// restarted by systemd on each deploy. Appending a row keeps the durability the
// per-request write had (the delta is on disk before saveRequestUsage returns)
// while moving the O(blob) work off the request path.
//
// Readers fold any not-yet-flushed rows on top of the blob (flushDayRollup is
// awaited by getUsageStats/getChartData), so a dashboard poll is always exact.
const DAY_FLUSH_INTERVAL_MS = 1000;
let dayFlushTimer: NodeJS.Timeout | null = null;

function scheduleDayFlush(): void {
  if (dayFlushTimer) return;
  dayFlushTimer = setTimeout(() => {
    dayFlushTimer = null;
    flushDayRollup().catch((e) => console.error("[usageRepo] day rollup flush failed:", e.message));
  }, DAY_FLUSH_INTERVAL_MS);
  dayFlushTimer.unref?.();
}

/**
 * Append one entry's contribution to the pending log. Runs inside the caller's
 * transaction, next to the history insert, so both land or neither does.
 */
function stageDayEntry(db: ResolvedDbAdapter, dateKey: string, entry: UsageEntry): void {
  db.run(
    `INSERT INTO usagePending(dateKey, entry) VALUES(?, ?)`,
    [dateKey, stringifyJson({
      provider: entry.provider || null,
      model: entry.model || null,
      connectionId: entry.connectionId || null,
      apiKey: entry.apiKey || null,
      endpoint: entry.endpoint || null,
      tokens: entry.tokens || {},
      cost: entry.cost || 0,
    })]
  );
  scheduleDayFlush();
}

function emptyDay(): UsageDay {
  return {
    requests: 0, promptTokens: 0, completionTokens: 0, cost: 0,
    byProvider: {}, byModel: {}, byAccount: {}, byApiKey: {}, byEndpoint: {},
  };
}

/**
 * Fold every pending row into its day blob, then delete the rows. One
 * transaction, so a crash mid-flush re-folds nothing and loses nothing: either
 * the blob carries the deltas and the rows are gone, or neither happened.
 */
export async function flushDayRollup() {
  const db = await getAdapter();
  const rows = db.all<{ id: number; dateKey: string; entry: string }>(
    `SELECT id, dateKey, entry FROM usagePending ORDER BY id ASC`
  );
  if (!rows.length) return;

  const byDay = new Map<string, UsageEntry[]>();
  for (const row of rows) {
    const parsed = parseJson<UsageEntry | null>(row.entry, null);
    if (!parsed) continue;
    if (!byDay.has(row.dateKey)) byDay.set(row.dateKey, []);
    byDay.get(row.dateKey)!.push(parsed);
  }

  db.transaction(() => {
    for (const [dateKey, entries] of byDay) {
      const stored = db.get<{ data: string }>(
        `SELECT data FROM usageDaily WHERE dateKey = ?`,
        [dateKey]
      );
      const day: UsageDay = stored ? parseJson<UsageDay>(stored.data, emptyDay()) : emptyDay();
      for (const entry of entries) aggregateEntryToDay(day, entry);
      db.run(
        `INSERT INTO usageDaily(dateKey, data) VALUES(?, ?) ON CONFLICT(dateKey) DO UPDATE SET data = excluded.data`,
        [dateKey, stringifyJson(day)]
      );
    }
    // Only the rows this flush actually folded. A row inserted while the merge
    // above was running has a higher id and stays pending for the next flush.
    const lastId = rows[rows.length - 1].id;
    db.run(`DELETE FROM usagePending WHERE id <= ?`, [lastId]);
  });
}

// Flush before serving a reader, so the dashboard never reports a rollup that is
// missing the last second of traffic.
async function flushDayRollupQuietly() {
  try {
    await flushDayRollup();
  } catch { /* the reader still serves the last persisted rollup */ }
}

/** connectionId -> a label a human recognises (name, else email, else the id). */
type ConnectionMap = Record<string, string>;

async function getConnectionMapCached(): Promise<ConnectionMap> {
  if (Date.now() - connCache.ts < CONN_CACHE_TTL_MS) return connCache.map;
  try {
    const { getProviderConnections } = await import("./connectionsRepo");
    const all = await getProviderConnections();
    const map: ConnectionMap = {};
    for (const c of all) if (c) map[c.id] = c.name || c.email || c.id;
    connCache.map = map;
    connCache.ts = Date.now();
  } catch {}
  return connCache.map;
}

async function ensureRingInitialized() {
  if (recentRing.initialized) return;
  recentRing.initialized = true;
  try {
    const db = await getAdapter();
    const rows = db.all<DbRow>(
      `SELECT timestamp, provider, model, connectionId, apiKey, endpoint, cost, status, tokens, meta FROM usageHistory ORDER BY id DESC LIMIT ?`,
      [RING_CAP]
    );
    recentRing.items = rows.reverse().map((r): UsageEntry => ({
      timestamp: String(r.timestamp),
      provider: (r.provider as string | null) ?? null,
      model: (r.model as string | null) ?? null,
      // The `model` column holds the name the caller asked for (a combo name
      // survives there); the real target rides along in meta. Restoring it keeps
      // the live stream honest after a restart instead of showing the combo.
      resolvedModel: (parseJson<Record<string, unknown>>(r.meta as string | null, {}) || {}).resolvedModel as string | null ?? null,
      connectionId: (r.connectionId as string | null) ?? null,
      apiKey: (r.apiKey as string | null) ?? null,
      endpoint: (r.endpoint as string | null) ?? null,
      cost: Number(r.cost) || 0,
      status: (r.status as string | null) ?? null,
      tokens: parseJson<UsageTokens>(r.tokens as string | null, {}),
    }));
  } catch {}
}

async function calculateCost(
  provider: string | null | undefined,
  model: string | null | undefined,
  tokens: UsageTokens | null | undefined
): Promise<number> {
  if (!tokens || !provider || !model) return 0;
  try {
    const { getPricingForModel } = await import("./pricingRepo");
    const pricing = await getPricingForModel(provider, model);
    if (!pricing) return 0;

    // Delegate the actual math to the single source of truth (avoids the two
    // copies drifting apart - see open-sse/providers/pricing.js for the
    // cache-inclusive prompt_tokens convention this assumes).
    const { calculateCostFromTokens } = await import("open-sse/providers/pricing");
    return calculateCostFromTokens(tokens, pricing);
  } catch (e) {
    console.error("Error calculating cost:", e);
    return 0;
  }
}

export function trackPendingRequest(
  model: string,
  provider: string | null | undefined,
  connectionId: string | null | undefined,
  started: boolean,
  error = false
): void {
  const modelKey = provider ? `${model} (${provider})` : model;
  const timerKey = `${connectionId}|${modelKey}`;

  if (!pendingRequests.byModel[modelKey]) pendingRequests.byModel[modelKey] = 0;
  pendingRequests.byModel[modelKey] = Math.max(0, pendingRequests.byModel[modelKey] + (started ? 1 : -1));
  if (pendingRequests.byModel[modelKey] === 0) delete pendingRequests.byModel[modelKey];

  if (connectionId) {
    if (!pendingRequests.byAccount[connectionId]) pendingRequests.byAccount[connectionId] = {};
    if (!pendingRequests.byAccount[connectionId][modelKey]) pendingRequests.byAccount[connectionId][modelKey] = 0;
    pendingRequests.byAccount[connectionId][modelKey] = Math.max(0, pendingRequests.byAccount[connectionId][modelKey] + (started ? 1 : -1));
    if (pendingRequests.byAccount[connectionId][modelKey] === 0) {
      delete pendingRequests.byAccount[connectionId][modelKey];
      if (Object.keys(pendingRequests.byAccount[connectionId]).length === 0) {
        delete pendingRequests.byAccount[connectionId];
      }
    }
  }

  if (started) {
    clearTimeout(pendingTimers[timerKey]);
    pendingTimers[timerKey] = setTimeout(() => {
      delete pendingTimers[timerKey];
      if (pendingRequests.byModel[modelKey] > 0) pendingRequests.byModel[modelKey] = 0;
      if (connectionId && pendingRequests.byAccount[connectionId]?.[modelKey] > 0) {
        pendingRequests.byAccount[connectionId][modelKey] = 0;
      }
      scheduleStatsEvent("pending");
    }, PENDING_TIMEOUT_MS);
  } else {
    clearTimeout(pendingTimers[timerKey]);
    delete pendingTimers[timerKey];
  }

  if (!started && error && provider) {
    lastErrorProvider.provider = provider.toLowerCase();
    lastErrorProvider.ts = Date.now();
  }

  // [PENDING] console line removed; lifecycle is visible via "▶" and "📊 done" lines
  scheduleStatsEvent("pending");
}

// Scoped variant for API-key dashboard sessions. Without a filter this returns the
// global view; with one, live rows another key triggered are never exposed and the
// history is narrowed to the key plus its allowed models. Pending traffic carries no
// key attribution, so a scoped caller gets an empty active list rather than a leak.

/** One minute of traffic on the "last 10 minutes" sparkline. */
export interface UsageBucket {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cost: number;
}

/** Per-model stats gain the raw/resolved model and a last-used stamp. */
export interface ModelUsageCounter extends UsageCounter {
  lastUsed?: string;
}

/** Per-account stats also carry the connection they belong to. */
export interface AccountUsageCounter extends UsageCounter {
  connectionId?: string | null;
  accountName?: string;
  lastUsed?: string;
}

/** One bar on the usage chart. */
export interface ChartBucket {
  label?: string;
  tokens: number;
  cost: number;
  requests: number;
}

/** The shape GET /api/usage/stats returns. */
export interface UsageStats {
  totalRequests: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCachedTokens: number;
  totalCost: number;
  byProvider: UsageCounters;
  byModel: Record<string, ModelUsageCounter>;
  byAccount: Record<string, AccountUsageCounter>;
  byApiKey: UsageCounters;
  byEndpoint: UsageCounters;
  last10Minutes: UsageBucket[];
  pending: unknown;
  activeRequests: ActiveRequest[];
  recentRequests: RecentRequest[];
  errorProvider: string;
  [key: string]: unknown;
}

/** One live request, as the dashboard lists it. */
export interface ActiveRequest {
  model: string;
  provider: string;
  account: string;
  count: number;
}

/** The identifying bits of an api key a dashboard label may use. */
export interface ApiKeyLabel {
  name: string;
  id: string;
  createdAt: string;
}

/** One finished request, as the dashboard lists it. */
export interface RecentRequest {
  timestamp: string;
  model: string;
  /** The name the caller asked for, when it differs from the serving model. */
  requestedModel?: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  status: string;
}

export async function getActiveRequests(
  filterApiKey: string | null = null,
  allowedModels = "*"
): Promise<{ activeRequests: ActiveRequest[]; recentRequests: RecentRequest[]; errorProvider: string }> {
  const activeRequests: ActiveRequest[] = [];
  const connectionMap = await getConnectionMapCached();

  if (!filterApiKey) {
    for (const [connectionId, models] of Object.entries(pendingRequests.byAccount)) {
      for (const [modelKey, count] of Object.entries(models)) {
        if (count > 0) {
          const accountName = connectionMap[connectionId] || `Account ${connectionId.slice(0, 8)}...`;
          const match = modelKey.match(/^(.*) \((.*)\)$/);
          activeRequests.push({
            model: match ? match[1] : modelKey,
            provider: match ? match[2] : "unknown",
            account: accountName, count,
          });
        }
      }
    }
  }

  const patterns = parseAllowedModels(allowedModels);
  const modelAllowed = (model: string) => matchesModelPatterns(patterns, model);

  await ensureRingInitialized();
  const recentRequests = [...recentRing.items]
    .filter((e) => !filterApiKey || e.apiKey === filterApiKey)
    .filter((e) => modelAllowed(String(e.model ?? "")))
    .sort((a, b) => Number(new Date(String(b.timestamp))) - Number(new Date(String(a.timestamp))))
    .map((e): RecentRequest => {
      const t = e.tokens || {};
      // The live stream is an operational view: an operator scanning it needs to
      // know which upstream actually served the call, not which combo abstracted
      // it. `model` carries the requested name (a combo survives there) and
      // `resolvedModel` the real target, so display the real one and keep the
      // alias as the qualifier.
      const resolved = (e as { resolvedModel?: string | null }).resolvedModel;
      const displayModel = resolved || String(e.model ?? "");
      return {
        timestamp: String(e.timestamp),
        model: displayModel,
        requestedModel: resolved ? String(e.model ?? "") : undefined,
        provider: e.provider || "",
        promptTokens: t.prompt_tokens || t.input_tokens || 0,
        completionTokens: t.completion_tokens || t.output_tokens || 0,
        cachedTokens: t.cached_tokens || t.cache_read_input_tokens || 0,
        status: e.status || "ok",
      };
    })
    .filter((e) => e.promptTokens > 0 || e.completionTokens > 0)
    .slice(0, 20);

  const errorProvider = (!filterApiKey && Date.now() - lastErrorProvider.ts < 10000)
    ? lastErrorProvider.provider
    : "";
  return { activeRequests, recentRequests, errorProvider };
}

/**
 * usageHistory has no natural size bound: one row per request, forever, and
 * nothing ever deletes them (requestDetails has maxRecords, this table had
 * nothing). On a gateway that runs for months that is an unbounded file.
 *
 * Nothing reads a raw row older than 60 days: getUsageStats/getChartData answer
 * 24h/7d/30d/60d from usageHistory and everything longer from the usageDaily
 * rollup, while lifetime totals live in _meta. So rows past the retention window
 * are dead weight.
 *
 * Runs opportunistically from the write path (at most once an hour) rather than a
 * timer, so it costs nothing on a gateway that is not taking traffic.
 */
const HISTORY_RETENTION_MS = 90 * 86400000;
const HISTORY_PRUNE_INTERVAL_MS = 3600000;
let lastHistoryPruneAt = 0;

function pruneHistory(db: ResolvedDbAdapter): void {
  const now = Date.now();
  if (now - lastHistoryPruneAt < HISTORY_PRUNE_INTERVAL_MS) return;
  lastHistoryPruneAt = now;
  try {
    db.run(`DELETE FROM usageHistory WHERE timestamp < ?`, [
      new Date(now - HISTORY_RETENTION_MS).toISOString(),
    ]);
  } catch { /* pruning must never fail a usage write */ }
}

// Test seam: the hourly throttle would otherwise make the prune untestable
// within one process (only the first call in a run ever prunes).
export const __test__ = {
  resetHistoryPruneThrottle() { lastHistoryPruneAt = 0; },
  HISTORY_RETENTION_MS,
};

export async function saveRequestUsage(
  entry: UsageEntry,
  options: { logOnly?: boolean; allowDuplicate?: boolean } = {}
): Promise<void> {
  // Lifecycle rows (pending/error) exist for the Request Logs view only. They
  // are NOT usage: a request that was billed nothing must not move token, cost
  // or lifetime-counter totals, so logOnly writes usageHistory alone.
  const logOnly = options.logOnly === true;
  const allowDuplicate = options.allowDuplicate === true || logOnly;
  try {
    const db = await getAdapter();

    if (!entry.timestamp) entry.timestamp = new Date().toISOString();
    entry.cost = logOnly ? 0 : await calculateCost(entry.provider, entry.model, entry.tokens);

    // Cost is priced from the REAL model + provider; the flip below only changes
    // what the dashboards display, never what is billed.
    const resolvedModel = entry.model;
    if (entry.requestedModel) entry.model = String(entry.requestedModel);
    entry.resolvedModel = entry.requestedModel ? resolvedModel : undefined;

    const tokens = entry.tokens || {};
    const promptTokens = tokens.prompt_tokens || tokens.input_tokens || 0;
    const completionTokens = tokens.completion_tokens || tokens.output_tokens || 0;

    let inserted = false;

    // All writes (history insert, daily upsert, lifetime counter) in ONE transaction.
    // better-sqlite3 is sync → no JS yield mid-transaction → no race in same process.
    db.transaction(() => {
      // A terminal write closes the request's open PENDING marker, so one
      // request is one log row rather than a start row plus an end row.
      if (entry.status !== "pending") {
        clearPendingRow(db, entry);
      }

      // Dedupe protects against ONE request being reported twice.
      //
      // With an explicit requestId we key on that — the only thing that can
      // actually identify a request, since every caller stamps its own
      // `new Date().toISOString()` and two reports of the same call are always
      // milliseconds apart. Without one we keep the historical byte-identical
      // key (timestamp+model+counts) so untagged callers behave exactly as
      // before.
      //
      // The id path exists because that legacy key is also a collision: two
      // DISTINCT requests that land on the same millisecond with equal token
      // counts (a burst of identical prompts on one key) matched it and one was
      // silently dropped. Callers in the chat path always supply an id now.
      //
      // The id is looked up from `requestIdIdx` (an indexed column), NOT from
      // `meta LIKE '%…%'`: that LIKE is a full table scan with no index it can
      // use, and measured 669us/write at 8k rows versus 6us for an indexed
      // lookup — on the per-request hot path.
      if (!allowDuplicate) {
        const existing = entry.requestId
          ? db.get(
            `SELECT id, endpoint FROM usageHistory
               WHERE requestId = ?
               ORDER BY id DESC LIMIT 1`,
            [String(entry.requestId)]
          )
          : db.get(
            `SELECT id, endpoint FROM usageHistory
               WHERE timestamp = ?
                 AND COALESCE(provider, '') = COALESCE(?, '')
                 AND COALESCE(model, '') = COALESCE(?, '')
                 AND COALESCE(connectionId, '') = COALESCE(?, '')
                 AND COALESCE(apiKey, '') = COALESCE(?, '')
                 AND promptTokens = ?
                 AND completionTokens = ?
               ORDER BY id DESC LIMIT 1`,
            [
              entry.timestamp, entry.provider || null, entry.model || null,
              entry.connectionId || null, entry.apiKey || null,
              promptTokens, completionTokens,
            ]
          );

        if (existing) {
          if (!existing.endpoint && entry.endpoint) {
            db.run(`UPDATE usageHistory SET endpoint = ? WHERE id = ?`, [entry.endpoint, existing.id]);
          }
          return;
        }
      }

        db.run(
        `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta, requestId) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.timestamp, entry.provider || null, entry.model || null,
          entry.connectionId || null, entry.apiKey || null, entry.endpoint || null,
          promptTokens, completionTokens, entry.cost || 0, entry.status || "ok",
          stringifyJson(tokens), stringifyJson(entry.requestedModel ? { resolvedModel } : {}),
          entry.requestId || null,
        ]
      );

      if (logOnly) {
        inserted = true;
        return;
      }

      const dateKey = getLocalDateKey(entry.timestamp);

      // Day rollup: append the delta next to the history insert, in the same
      // transaction. One small row, O(1) — the O(day-size) blob rewrite happens
      // in the periodic flush instead (see the coalesced writer above).
      stageDayEntry(db, dateKey, entry);

      // Atomic counter increment in same transaction
      const cur = db.get<{ value: string }>(
        `SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'`
      );
      const next = (cur ? parseInt(cur.value, 10) : 0) + 1;
      db.run(`INSERT INTO _meta(key, value) VALUES('totalRequestsLifetime', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(next)]);

      // Update API Key usedTokens and sliding window
      if (entry.apiKey) {
         const totalTokens = promptTokens + completionTokens;
         if (totalTokens > 0) {
            db.run(`UPDATE apiKeys SET usedTokens = COALESCE(usedTokens, 0) + ? WHERE key = ?`, [totalTokens, entry.apiKey]);
         }
         // Request counter for keys limited by request count, bumped once per logged
         // usage row so the gate and this writer read the same number.
         db.run(`UPDATE apiKeys SET usedRequests = COALESCE(usedRequests, 0) + 1 WHERE key = ?`, [entry.apiKey]);
         // Daily cost counter, written in the same transaction as the usage row so the
         // two can never disagree. date('now') is UTC, the same bucket utcDayKey()
         // returns: a new day replaces the counter instead of adding to yesterday's.
         const cost = Number(entry.cost) || 0;
         if (cost > 0) {
            db.run(
               `UPDATE apiKeys
                   SET costSpent = CASE WHEN costDay = date('now') THEN COALESCE(costSpent, 0) + ? ELSE ? END,
                       costDay = date('now')
                 WHERE key = ?`,
               [cost, cost, entry.apiKey]
            );
         }
         import("./apiKeysRepo").then(({ recordApiKeyUsageInWindow }) => {
           recordApiKeyUsageInWindow(entry.apiKey, totalTokens);
         }).catch(() => {});
      }

      inserted = true;
    });

    // Outside the transaction: a prune is housekeeping, and doing a large DELETE
    // inside the same transaction as the insert would hold the write lock for it.
    if (!logOnly) pruneHistory(db);

    if (inserted) {
      if (!logOnly) pushToRing(entry);
      scheduleStatsEvent("update", 250);
    }
  } catch (e) {
    console.error("Failed to save usage stats:", e);
  }
}

/** Filters accepted by getUsageHistory. */
export interface UsageHistoryFilter {
  provider?: string;
  model?: string;
  startDate?: string | number | Date;
  endDate?: string | number | Date;
  apiKey?: string;
}

/** One usageHistory row as the dashboard consumes it. */
export interface UsageHistoryRecord {
  timestamp: string;
  provider: string | null;
  model: string | null;
  connectionId: string | null;
  /** Never the raw secret: see apiKeyBucketId's note on AUDIT-002. */
  apiKeyMasked: string | null;
  endpoint: string | null;
  cost: number;
  status: string | null;
  tokens: UsageTokens;
  resolvedModel: string | null;
}

export async function getUsageHistory(
  filter: UsageHistoryFilter = {}
): Promise<UsageHistoryRecord[]> {
  const db = await getAdapter();
  const conds: string[] = [];
  const params: unknown[] = [];

  if (filter.provider) { conds.push("provider = ?"); params.push(filter.provider); }
  if (filter.model) { conds.push("model = ?"); params.push(filter.model); }
  if (filter.startDate) { conds.push("timestamp >= ?"); params.push(new Date(filter.startDate).toISOString()); }
  if (filter.endDate) { conds.push("timestamp <= ?"); params.push(new Date(filter.endDate).toISOString()); }
  if (filter.apiKey) { conds.push("apiKey = ?"); params.push(filter.apiKey); }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const rows = db.all<DbRow>(
    `SELECT timestamp, provider, model, connectionId, apiKey, endpoint, cost, status, tokens, meta FROM usageHistory ${where} ORDER BY id ASC`,
    params
  );

  return rows.map((r) => ({
    timestamp: String(r.timestamp),
    provider: (r.provider as string | null) ?? null,
    model: (r.model as string | null) ?? null,
    connectionId: (r.connectionId as string | null) ?? null,
    apiKeyMasked: maskApiKey(r.apiKey),
    endpoint: (r.endpoint as string | null) ?? null,
    cost: Number(r.cost) || 0,
    status: (r.status as string | null) ?? null,
    tokens: parseJson<UsageTokens>(r.tokens as string | null, {}),
    resolvedModel: (() => {
      try {
        return (parseJson<Record<string, unknown>>(r.meta as string | null, {}) || {}).resolvedModel as string | null || null;
      } catch { return null; }
    })(),
  }));
}

function loadDaysInRange(
  adapter: ResolvedDbAdapter,
  maxDays: number | null
): Array<{ dateKey: string; data: string }> {
  if (maxDays == null) {
    return adapter.all<{ dateKey: string; data: string }>(
      `SELECT dateKey, data FROM usageDaily ORDER BY dateKey ASC`
    );
  }
  const today = new Date();
  const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - maxDays + 1);
  const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;
  return adapter.all<{ dateKey: string; data: string }>(
    `SELECT dateKey, data FROM usageDaily WHERE dateKey >= ? ORDER BY dateKey ASC`,
    [cutoffKey]
  );
}

/**
 * Fold pending day-rollup rows into the `usageDaily` blob before reading it, so
 * the dashboard never reports a rollup missing the latest saved usage.
 *
 * Runs on the caller's already-open handle: opening a second one would take a
 * savepoint that conflicts with concurrent migrations under the sql.js adapter.
 */
function foldPendingRollupRows(adapter: ResolvedDbAdapter): void {
  const pendingRows = adapter.all<{ dateKey: string; entry: string }>(
    `SELECT dateKey, entry FROM usagePending ORDER BY id ASC`
  ) || [];
  for (const row of pendingRows) {
    const parsed = parseJson<UsageEntry | null>(row.entry, null);
    if (!parsed) continue;
    const stored = adapter.get<{ data: string }>(
      `SELECT data FROM usageDaily WHERE dateKey = ?`,
      [row.dateKey]
    );
    const day: UsageDay = stored ? parseJson<UsageDay>(stored.data, emptyDay()) : emptyDay();
    aggregateEntryToDay(day, parsed);
    adapter.run(
      `INSERT INTO usageDaily(dateKey, data) VALUES(?, ?) ON CONFLICT(dateKey) DO UPDATE SET data = excluded.data`,
      [row.dateKey, stringifyJson(day)]
    );
  }
  if (pendingRows.length) adapter.run(`DELETE FROM usagePending`);
}

/**
 * Fill the 10 one-minute buckets ending at the current minute.
 *
 * The buckets are pre-seeded so a quiet minute renders as zero rather than a gap,
 * then billed rows inside the window are summed into them.
 */
function buildLastTenMinutes(
  adapter: ResolvedDbAdapter,
  filterApiKey: string | null,
  modelAllowed: (model: string) => boolean
): UsageBucket[] {
  const now = new Date();
  const currentMinuteStart = new Date(Math.floor(now.getTime() / 60000) * 60000);
  const tenMinutesAgo = new Date(currentMinuteStart.getTime() - 9 * 60 * 1000);

  const buckets: UsageBucket[] = [];
  const bucketMap: Record<number, UsageBucket> = {};
  for (let i = 0; i < 10; i++) {
    const ts = currentMinuteStart.getTime() - (9 - i) * 60 * 1000;
    bucketMap[ts] = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
    buckets.push(bucketMap[ts]);
  }

  const sql = filterApiKey
    ? `SELECT timestamp, model, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ? AND timestamp <= ? AND apiKey = ? AND status = 'ok'`
    : `SELECT timestamp, model, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ? AND timestamp <= ? AND status = 'ok'`;
  const params = filterApiKey
    ? [tenMinutesAgo.toISOString(), now.toISOString(), filterApiKey]
    : [tenMinutesAgo.toISOString(), now.toISOString()];

  for (const r of adapter.all<DbRow>(sql, params)) {
    if (!modelAllowed(String(r.model ?? ""))) continue;
    const minuteStart = Math.floor(new Date(String(r.timestamp)).getTime() / 60000) * 60000;
    const bucket = bucketMap[minuteStart];
    if (!bucket) continue;
    bucket.requests++;
    bucket.promptTokens += Number(r.promptTokens) || 0;
    bucket.completionTokens += Number(r.completionTokens) || 0;
    bucket.cost += Number(r.cost) || 0;
  }
  return buckets;
}

/**
 * ISO cutoff for a period, or null for unbounded ("all").
 * `today` means local midnight, so it cannot be derived from PERIOD_MS.
 */
function periodCutoff(period: string): string | null {
  if (period === "today") {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    return startOfDay.toISOString();
  }
  const span = PERIOD_MS[period];
  return span ? new Date(Date.now() - span).toISOString() : null;
}

export async function getUsageStats(
  period = "all",
  filterApiKey: string | null = null,
  allowedModels = "*"
): Promise<UsageStats> {
  const db = await getAdapter();

  foldPendingRollupRows(db);

  const patterns = parseAllowedModels(allowedModels);
  const modelAllowed = (model: string) => matchesModelPatterns(patterns, model);

  const [{ getProviderConnections }, { getApiKeys }, { getProviderNodes }] = await Promise.all([
    import("./connectionsRepo"),
    import("./apiKeysRepo"),
    import("./nodesRepo"),
  ]);

  let allConnections: Awaited<ReturnType<typeof getProviderConnections>> = [];
  try { allConnections = await getProviderConnections(); } catch {}
  const connectionMap: ConnectionMap = {};
  for (const c of allConnections) if (c) connectionMap[c.id] = c.name || c.email || c.id;

  const providerNodeNameMap: Record<string, string> = {};
  try {
    const nodes = await getProviderNodes();
    for (const n of nodes) if (n.id && n.name) providerNodeNameMap[n.id] = n.name;
  } catch {}

  let allApiKeys: Awaited<ReturnType<typeof getApiKeys>> = [];
  try { allApiKeys = await getApiKeys(); } catch {}
  const apiKeyMap: Record<string, ApiKeyLabel> = {};
  // Bucket id → key record. usageDaily stores only the masked key plus the
  // bucket id embedded in its entry key, so the daily branch cannot look a name
  // up by raw key the way the live-history branch does.
  const apiKeyBucketMap: Record<string, ApiKeyLabel> = {};
  for (const k of allApiKeys) {
    if (k.key) {
      const trimmed = k.key.trim();
      apiKeyMap[trimmed] = { name: k.name, id: k.id, createdAt: k.createdAt };
      apiKeyBucketMap[apiKeyBucketId(trimmed)] = { name: k.name, id: k.id, createdAt: k.createdAt };
    }
  }

  // Read enough recent rows to account for filtered lifecycle/zero-usage entries.
  // `meta` must come along: the `model` column holds the requested name (a combo
  // survives there) and the real target rides in `meta.resolvedModel`, so a row
  // mapped without it reports the combo as if it were a model.
  const recentSql = filterApiKey
    ? `SELECT timestamp, provider, model, tokens, status, meta FROM usageHistory WHERE apiKey = ? ORDER BY id DESC LIMIT 100`
    : `SELECT timestamp, provider, model, tokens, status, meta FROM usageHistory ORDER BY id DESC LIMIT 100`;
  const recentParams = filterApiKey ? [filterApiKey] : [];
  const recentRows = db.all<DbRow>(recentSql, recentParams);
  const recentRequests = recentRows
    .map((r): RecentRequest => {
      const t = parseJson<UsageTokens>(r.tokens as string | null, {}) || {};
      const resolved = (parseJson<Record<string, unknown>>(r.meta as string | null, {}) || {}).resolvedModel as string | null | undefined;
      const requested = String(r.model ?? "");
      return {
        timestamp: String(r.timestamp),
        model: resolved || requested,
        requestedModel: resolved ? requested : undefined,
        provider: (r.provider as string) || "",
        promptTokens: t.prompt_tokens || t.input_tokens || 0,
        completionTokens: t.completion_tokens || t.output_tokens || 0,
        cachedTokens: t.cached_tokens || t.cache_read_input_tokens || 0,
        status: (r.status as string) || "ok",
      };
    })
    .filter((e) => {
      // Only billed ("ok") rows count toward usage; pending/error lifecycle
      // rows live in the request log but must never inflate totals.
      if (e.status !== "ok") return false;
      if (!modelAllowed(e.model)) return false;
      if (e.promptTokens === 0 && e.completionTokens === 0) return false;
      return true;
    })
    .slice(0, 20);

  const stats = {
    totalRequests: 0,
    totalPromptTokens: 0, totalCompletionTokens: 0, totalCachedTokens: 0, totalCost: 0,
    byProvider: {}, byModel: {}, byAccount: {}, byApiKey: {}, byEndpoint: {},
    last10Minutes: [],
    pending: filterApiKey ? {} : pendingRequests,
    activeRequests: filterApiKey ? [] : [],
    recentRequests,
    errorProvider: (Date.now() - lastErrorProvider.ts < 10000) ? lastErrorProvider.provider : "",
  };

  // Active requests - only populate for global view, or filter for specific key
  if (!filterApiKey) {
    for (const [connectionId, models] of Object.entries(pendingRequests.byAccount)) {
      for (const [modelKey, count] of Object.entries(models)) {
        if (count > 0) {
          const accountName = connectionMap[connectionId] || `Account ${connectionId.slice(0, 8)}...`;
          const match = modelKey.match(/^(.*) \((.*)\)$/);
          stats.activeRequests.push({
            model: match ? match[1] : modelKey,
            provider: match ? match[2] : "unknown",
            account: accountName, count,
          });
        }
      }
    }
  }

  stats.last10Minutes = buildLastTenMinutes(db, filterApiKey, modelAllowed);

  if (filterApiKey) {
    const cutoff = periodCutoff(period);

    const where: string[] = ["apiKey = ?", "status = 'ok'"];
    const params: unknown[] = [filterApiKey];
    if (cutoff) {
      where.push("timestamp >= ?");
      params.push(cutoff);
    }

    const filtered = db.all<DbRow>(
      `SELECT timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, tokens, meta FROM usageHistory WHERE ${where.join(" AND ")}`,
      params
    );

    for (const r of filtered) {
      const rawProvider = String(r.provider ?? "");
      const rawModel = String(r.model ?? "");
      const rawApiKey = String(r.apiKey ?? "");
      const rawTimestamp = String(r.timestamp ?? "");
      const rawEndpoint = String(r.endpoint ?? "");
      const connectionId = r.connectionId ? String(r.connectionId) : null;
      if (!modelAllowed(rawModel)) continue;
      const tokens = parseJson<UsageTokens>(r.tokens as string | null, {});
      const promptTokens = Number(r.promptTokens) || tokens.prompt_tokens || tokens.input_tokens || 0;
      const completionTokens =
        Number(r.completionTokens) || tokens.completion_tokens || tokens.output_tokens || 0;
      const cachedTokens = tokens.cached_tokens || tokens.cache_read_input_tokens || 0;
      const entryCost = Number(r.cost) || 0;
      const providerDisplayName = providerNodeNameMap[rawProvider] || rawProvider;

      stats.totalPromptTokens += promptTokens;
      stats.totalCompletionTokens += completionTokens;
      stats.totalCachedTokens += cachedTokens;
      stats.totalCost += entryCost;

      stats.byProvider[rawProvider] ||= { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
      stats.byProvider[rawProvider].requests++;
      stats.byProvider[rawProvider].promptTokens += promptTokens;
      stats.byProvider[rawProvider].completionTokens += completionTokens;
      stats.byProvider[rawProvider].cachedTokens += cachedTokens;
      stats.byProvider[rawProvider].cost += entryCost;

      const modelKey = rawProvider ? `${rawModel} (${rawProvider})` : rawModel;
      stats.byModel[modelKey] ||= {
        requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0,
        rawModel, provider: providerDisplayName,
        resolvedModel:
          (parseJson<Record<string, unknown>>(r.meta as string | null, {}) || {}).resolvedModel as
            | string
            | undefined,
        lastUsed: rawTimestamp,
      };
      stats.byModel[modelKey].requests++;
      stats.byModel[modelKey].promptTokens += promptTokens;
      stats.byModel[modelKey].completionTokens += completionTokens;
      stats.byModel[modelKey].cachedTokens += cachedTokens;
      stats.byModel[modelKey].cost += entryCost;
      if (new Date(rawTimestamp) > new Date(String(stats.byModel[modelKey].lastUsed))) {
        stats.byModel[modelKey].lastUsed = rawTimestamp;
      }

      if (connectionId) {
        const accountName = connectionMap[connectionId] || `Account ${connectionId.slice(0, 8)}...`;
        const accountKey = `${rawModel} (${rawProvider} - ${accountName})`;
        stats.byAccount[accountKey] ||= {
          requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0,
          rawModel, provider: providerDisplayName, connectionId, accountName,
          lastUsed: rawTimestamp,
        };
        stats.byAccount[accountKey].requests++;
        stats.byAccount[accountKey].promptTokens += promptTokens;
        stats.byAccount[accountKey].completionTokens += completionTokens;
        stats.byAccount[accountKey].cachedTokens += cachedTokens;
        stats.byAccount[accountKey].cost += entryCost;
        if (new Date(rawTimestamp) > new Date(String(stats.byAccount[accountKey].lastUsed))) {
          stats.byAccount[accountKey].lastUsed = rawTimestamp;
        }
      }

      const keyInfo = apiKeyMap[rawApiKey];
      const keyName = keyInfo?.name || rawApiKey.slice(0, 8) + "...";
      const apiKeyMasked = maskApiKey(rawApiKey);
      const akKey = `${apiKeyMasked}|${rawModel}|${rawProvider || "unknown"}`;
      stats.byApiKey[akKey] ||= {
        requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0,
        rawModel, provider: providerDisplayName, apiKeyMasked, keyName,
        apiKeyKey: apiKeyMasked, lastUsed: rawTimestamp,
      };
      const ake = stats.byApiKey[akKey];
      ake.requests++; ake.promptTokens += promptTokens; ake.completionTokens += completionTokens; ake.cachedTokens += cachedTokens; ake.cost += entryCost;
      if (new Date(rawTimestamp) > new Date(String(ake.lastUsed))) ake.lastUsed = rawTimestamp;

      const endpoint = rawEndpoint || "Unknown";
      const epKey = `${endpoint}|${rawModel}|${rawProvider || "unknown"}`;
      stats.byEndpoint[epKey] ||= {
        requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0,
        endpoint, rawModel, provider: providerDisplayName, lastUsed: rawTimestamp,
      };
      const epe = stats.byEndpoint[epKey];
      epe.requests++; epe.promptTokens += promptTokens; epe.completionTokens += completionTokens; epe.cachedTokens += cachedTokens; epe.cost += entryCost;
      if (new Date(rawTimestamp) > new Date(String(epe.lastUsed))) epe.lastUsed = rawTimestamp;
    }

    stats.totalRequests = (Object.values(stats.byProvider) as UsageCounter[]).reduce(
      (sum, p) => sum + (p.requests || 0),
      0
    );
    return stats;
  }

  const useDailySummary = period !== "24h" && period !== "today";

  if (useDailySummary) {
    const periodDays: Record<string, number> = { "7d": 7, "30d": 30, "60d": 60 };
    const maxDays: number | null = periodDays[period] || null;
    const dayRows = loadDaysInRange(db, maxDays);

    for (const dr of dayRows) {
      const dateKey = dr.dateKey;
      const day = parseJson<UsageDay>(dr.data, emptyDay());
      if (patterns === null) {
        stats.totalPromptTokens += day.promptTokens || 0;
        stats.totalCompletionTokens += day.completionTokens || 0;
        stats.totalCachedTokens += day.cachedTokens || 0;
        stats.totalCost += day.cost || 0;

        for (const [prov, p] of Object.entries(day.byProvider || {}) as Array<[string, UsageCounter]>) {
          if (!stats.byProvider[prov]) stats.byProvider[prov] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
          stats.byProvider[prov].requests += p.requests || 0;
          stats.byProvider[prov].promptTokens += p.promptTokens || 0;
          stats.byProvider[prov].completionTokens += p.completionTokens || 0;
          stats.byProvider[prov].cachedTokens += p.cachedTokens || 0;
          stats.byProvider[prov].cost += p.cost || 0;
        }
      }

      for (const [mk, m] of Object.entries(day.byModel || {})) {
        const rawModel = m.rawModel || mk.split("|")[0];
        if (!modelAllowed(rawModel)) continue;
        const provider = m.provider || mk.split("|")[1] || "";
        const statsKey = provider ? `${rawModel} (${provider})` : rawModel;
        const providerDisplayName = providerNodeNameMap[provider] || provider;
        if (!stats.byModel[statsKey]) {
        stats.byModel[statsKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel, provider: providerDisplayName, resolvedModel: m.resolvedModel || undefined, lastUsed: dateKey };
        }
        stats.byModel[statsKey].requests += m.requests || 0;
        stats.byModel[statsKey].promptTokens += m.promptTokens || 0;
        stats.byModel[statsKey].completionTokens += m.completionTokens || 0;
        stats.byModel[statsKey].cachedTokens += m.cachedTokens || 0;
        stats.byModel[statsKey].cost += m.cost || 0;
        if (dateKey > (stats.byModel[statsKey].lastUsed || "")) stats.byModel[statsKey].lastUsed = dateKey;

        // Day totals and provider buckets carry no model dimension, so in
        // restricted mode they are rebuilt from the matching model buckets.
        if (patterns !== null) {
          stats.totalPromptTokens += m.promptTokens || 0;
          stats.totalCompletionTokens += m.completionTokens || 0;
          stats.totalCachedTokens += m.cachedTokens || 0;
          stats.totalCost += m.cost || 0;

          if (provider) {
            if (!stats.byProvider[provider]) stats.byProvider[provider] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
            stats.byProvider[provider].requests += m.requests || 0;
            stats.byProvider[provider].promptTokens += m.promptTokens || 0;
            stats.byProvider[provider].completionTokens += m.completionTokens || 0;
            stats.byProvider[provider].cachedTokens += m.cachedTokens || 0;
            stats.byProvider[provider].cost += m.cost || 0;
          }
        }
      }

      for (const [acctKey, a] of Object.entries(day.byAccount || {})) {
        // byAccount keys are `connectionId|model|provider`; databases written
        // before that shape hold a bare connectionId with a single rawModel that
        // absorbed every model's tokens. Parse both so an upgrade reads its own
        // history instead of showing "Account undefined...".
        const [connId, keyModel, keyProvider] = acctKey.split("|");
        const accountName = connectionMap[connId] || `Account ${connId.slice(0, 8)}...`;
        const rawModel = a.rawModel || "";
        if (!modelAllowed(rawModel)) continue;
        const provider = a.provider || "";
        const providerDisplayName = providerNodeNameMap[provider] || provider;
        const accountKey = `${rawModel} (${provider} - ${accountName})`;
        if (!stats.byAccount[accountKey]) {
          stats.byAccount[accountKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel, provider: providerDisplayName, connectionId: connId, accountName, lastUsed: dateKey };
        }
        stats.byAccount[accountKey].requests += a.requests || 0;
        stats.byAccount[accountKey].promptTokens += a.promptTokens || 0;
        stats.byAccount[accountKey].completionTokens += a.completionTokens || 0;
        stats.byAccount[accountKey].cachedTokens += a.cachedTokens || 0;
        stats.byAccount[accountKey].cost += a.cost || 0;
        if (dateKey > (stats.byAccount[accountKey].lastUsed || "")) stats.byAccount[accountKey].lastUsed = dateKey;
      }

      for (const [akKey, ak] of Object.entries(day.byApiKey || {})) {
        const rawModel = ak.rawModel || "";
        if (!modelAllowed(rawModel)) continue;
        const provider = ak.provider || "";
        const providerDisplayName = providerNodeNameMap[provider] || provider;
        // `ak.apiKey` in usageDaily is already MASKED (see aggregateEntryToDay);
        // the raw key never touches this table. Resolve the key's display name
        // from the bucket id parsed out of the entry key instead, which is what
        // the bucket was built from.
        const bucketId = akKey.includes("|") ? akKey.split("|")[0] : null;
        const keyInfo = bucketId ? apiKeyBucketMap[bucketId] : null;
        // Legacy rows (written before the mask) still hold either a raw key or
        // "local-no-key" here; mask whatever survived so nothing replayable
        // reaches the wire.
        const storedKey = typeof ak.apiKey === "string" ? ak.apiKey : ""
        const apiKeyMasked = storedKey && storedKey !== "local-no-key"
          ? (storedKey.length > 12 ? maskApiKey(storedKey) : storedKey)
          : null;
        const keyName = keyInfo?.name || apiKeyMasked || "Local (No API Key)";
        const apiKeyKey = apiKeyMasked || "local-no-key";
        if (!stats.byApiKey[akKey]) {
          stats.byApiKey[akKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel, provider: providerDisplayName, apiKeyMasked, keyName, apiKeyKey, lastUsed: dateKey };
        }
        stats.byApiKey[akKey].requests += ak.requests || 0;
        stats.byApiKey[akKey].promptTokens += ak.promptTokens || 0;
        stats.byApiKey[akKey].completionTokens += ak.completionTokens || 0;
        stats.byApiKey[akKey].cachedTokens += ak.cachedTokens || 0;
        stats.byApiKey[akKey].cost += ak.cost || 0;
        if (dateKey > (stats.byApiKey[akKey].lastUsed || "")) stats.byApiKey[akKey].lastUsed = dateKey;
      }

      for (const [epKey, ep] of Object.entries(day.byEndpoint || {})) {
        const endpoint = ep.endpoint || epKey.split("|")[0] || "Unknown";
        const rawModel = ep.rawModel || "";
        if (!modelAllowed(rawModel)) continue;
        const provider = ep.provider || "";
        const providerDisplayName = providerNodeNameMap[provider] || provider;
        if (!stats.byEndpoint[epKey]) {
          stats.byEndpoint[epKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, endpoint, rawModel, provider: providerDisplayName, lastUsed: dateKey };
        }
        stats.byEndpoint[epKey].requests += ep.requests || 0;
        stats.byEndpoint[epKey].promptTokens += ep.promptTokens || 0;
        stats.byEndpoint[epKey].completionTokens += ep.completionTokens || 0;
        stats.byEndpoint[epKey].cachedTokens += ep.cachedTokens || 0;
        stats.byEndpoint[epKey].cost += ep.cost || 0;
        if (dateKey > (stats.byEndpoint[epKey].lastUsed || "")) stats.byEndpoint[epKey].lastUsed = dateKey;
      }
    }

    // Overlay precise lastUsed timestamps from history.
    // ponytail: overlay scans only a recent window; entries older than that keep
    // day-level lastUsed from usageDaily. Upgrade to a materialized per-key
    // MAX(timestamp) table if exact old timestamps ever matter.
    const OVERLAY_WINDOW_MS = 2 * 86400000;
    const overlayCutoff = Math.max(
      maxDays ? Date.now() - maxDays * 86400000 : 0,
      Date.now() - OVERLAY_WINDOW_MS
    );
    const histRows = db.all<DbRow>(
      `SELECT timestamp, provider, model, connectionId, apiKey, endpoint FROM usageHistory WHERE timestamp >= ?`,
      [new Date(overlayCutoff).toISOString()]
    );
    for (const e of histRows) {
      const ts = String(e.timestamp ?? "");
      const histModel = String(e.model ?? "");
      const histProvider = String(e.provider ?? "");
      const histConnectionId = e.connectionId ? String(e.connectionId) : null;
      if (!modelAllowed(histModel)) continue;
      const modelKey = histProvider ? `${histModel} (${histProvider})` : histModel;
      if (stats.byModel[modelKey] && new Date(ts) > new Date(stats.byModel[modelKey].lastUsed)) stats.byModel[modelKey].lastUsed = ts;

      if (histConnectionId) {
        const accountName = connectionMap[histConnectionId] || `Account ${histConnectionId.slice(0, 8)}...`;
        const accountKey = `${histModel} (${histProvider} - ${accountName})`;
        if (stats.byAccount[accountKey] && new Date(ts) > new Date(stats.byAccount[accountKey].lastUsed)) stats.byAccount[accountKey].lastUsed = ts;
      }

      const rawHistKey = e.apiKey && typeof e.apiKey === "string" ? e.apiKey : null;
      const apiKeyKey = rawHistKey
        ? `${apiKeyBucketId(rawHistKey)}|${histModel}|${histProvider || "unknown"}`
        : "local-no-key";
      if (stats.byApiKey[apiKeyKey] && new Date(ts) > new Date(stats.byApiKey[apiKeyKey].lastUsed)) stats.byApiKey[apiKeyKey].lastUsed = ts;

      const endpoint = String(e.endpoint ?? "") || "Unknown";
      const endpointKey = `${endpoint}|${histModel}|${histProvider || "unknown"}`;
      if (stats.byEndpoint[endpointKey] && new Date(ts) > new Date(stats.byEndpoint[endpointKey].lastUsed)) stats.byEndpoint[endpointKey].lastUsed = ts;
    }
  } else {
    // 24h / today: live history is the precise source.
    let cutoff;
    if (period === "today") {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      cutoff = startOfDay.toISOString();
    } else {
      cutoff = new Date(Date.now() - PERIOD_MS["24h"]).toISOString();
    }
    const filtered = db.all(
      `SELECT timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, tokens, meta FROM usageHistory WHERE timestamp >= ? AND status = 'ok'`,
      [cutoff]
    );

    for (const r of filtered) {
      const rawProvider = String(r.provider ?? "");
      const rawModel = String(r.model ?? "");
      const rawTimestamp = String(r.timestamp ?? "");
      const rawApiKey = String(r.apiKey ?? "");
      const connectionId = r.connectionId ? String(r.connectionId) : null;
      if (!modelAllowed(rawModel)) continue;
      const tokens = parseJson<UsageTokens>(r.tokens as string | null, {});
      const promptTokens = Number(r.promptTokens) || tokens.prompt_tokens || tokens.input_tokens || 0;
      const completionTokens =
        Number(r.completionTokens) || tokens.completion_tokens || tokens.output_tokens || 0;
      const cachedTokens = tokens.cached_tokens || tokens.cache_read_input_tokens || 0;
      const entryCost = Number(r.cost) || 0;
      const providerDisplayName = providerNodeNameMap[rawProvider] || rawProvider;

      stats.totalPromptTokens += promptTokens;
      stats.totalCompletionTokens += completionTokens;
      stats.totalCachedTokens += cachedTokens;
      stats.totalCost += entryCost;

      stats.byProvider[rawProvider] ||= { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
      stats.byProvider[rawProvider].requests++;
      stats.byProvider[rawProvider].promptTokens += promptTokens;
      stats.byProvider[rawProvider].completionTokens += completionTokens;
      stats.byProvider[rawProvider].cachedTokens += cachedTokens;
      stats.byProvider[rawProvider].cost += entryCost;

      const modelKey = rawProvider ? `${rawModel} (${rawProvider})` : rawModel;
      stats.byModel[modelKey] ||= {
        requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0,
        rawModel, provider: providerDisplayName,
        resolvedModel:
          (parseJson<Record<string, unknown>>(r.meta as string | null, {}) || {}).resolvedModel as
            | string
            | undefined,
        lastUsed: rawTimestamp,
      };
      stats.byModel[modelKey].requests++;
      stats.byModel[modelKey].promptTokens += promptTokens;
      stats.byModel[modelKey].completionTokens += completionTokens;
      stats.byModel[modelKey].cachedTokens += cachedTokens;
      stats.byModel[modelKey].cost += entryCost;
      if (new Date(rawTimestamp) > new Date(String(stats.byModel[modelKey].lastUsed))) {
        stats.byModel[modelKey].lastUsed = rawTimestamp;
      }

      if (connectionId) {
        const accountName = connectionMap[connectionId] || `Account ${connectionId.slice(0, 8)}...`;
        const accountKey = `${rawModel} (${rawProvider} - ${accountName})`;
        stats.byAccount[accountKey] ||= {
          requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0,
          rawModel, provider: providerDisplayName, connectionId, accountName,
          lastUsed: rawTimestamp,
        };
        stats.byAccount[accountKey].requests++;
        stats.byAccount[accountKey].promptTokens += promptTokens;
        stats.byAccount[accountKey].completionTokens += completionTokens;
        stats.byAccount[accountKey].cachedTokens += cachedTokens;
        stats.byAccount[accountKey].cost += entryCost;
        if (new Date(rawTimestamp) > new Date(String(stats.byAccount[accountKey].lastUsed))) {
          stats.byAccount[accountKey].lastUsed = rawTimestamp;
        }
      }

      if (rawApiKey) {
        const keyInfo = apiKeyMap[rawApiKey];
        const keyName = keyInfo?.name || rawApiKey.slice(0, 8) + "...";
        const apiKeyMasked = maskApiKey(rawApiKey);
        // Key by the FULL api key (same as the daily rollup + lastUsed overlay)
        // - masking here collided all keys sharing a prefix into one bucket.
        const akKey = `${apiKeyMasked}|${rawModel}|${rawProvider || "unknown"}`;
        stats.byApiKey[akKey] ||= {
          requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0,
          rawModel, provider: providerDisplayName, apiKeyMasked, keyName,
          apiKeyKey: apiKeyMasked, lastUsed: rawTimestamp,
        };
        const ake = stats.byApiKey[akKey];
        ake.requests++; ake.promptTokens += promptTokens; ake.completionTokens += completionTokens; ake.cachedTokens += cachedTokens; ake.cost += entryCost;
        if (new Date(rawTimestamp) > new Date(String(ake.lastUsed))) ake.lastUsed = rawTimestamp;
      } else {
        stats.byApiKey["local-no-key"] ||= {
          requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0,
          rawModel, provider: providerDisplayName, apiKeyMasked: null,
          keyName: "Local (No API Key)", apiKeyKey: "local-no-key", lastUsed: rawTimestamp,
        };
        const ake = stats.byApiKey["local-no-key"];
        ake.requests++; ake.promptTokens += promptTokens; ake.completionTokens += completionTokens; ake.cachedTokens += cachedTokens; ake.cost += entryCost;
        if (new Date(rawTimestamp) > new Date(String(ake.lastUsed))) ake.lastUsed = rawTimestamp;
      }

      const endpoint = String(r.endpoint ?? "") || "Unknown";
      const epKey = `${endpoint}|${rawModel}|${rawProvider || "unknown"}`;
      stats.byEndpoint[epKey] ||= {
        requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0,
        endpoint, rawModel, provider: providerDisplayName, lastUsed: rawTimestamp,
      };
      const epe = stats.byEndpoint[epKey];
      epe.requests++; epe.promptTokens += promptTokens; epe.completionTokens += completionTokens; epe.cachedTokens += cachedTokens; epe.cost += entryCost;
      if (new Date(rawTimestamp) > new Date(String(epe.lastUsed))) epe.lastUsed = rawTimestamp;
    }
  }

  stats.totalRequests = (Object.values(stats.byProvider) as UsageCounter[]).reduce(
    (sum, p) => sum + (p.requests || 0),
    0
  );
  return stats;
}

export async function getChartData(period = "7d", filterApiKey = null, allowedModels = "*") {
  const db = await getAdapter();
  // Same rule as getUsageStats: fold staged rollup deltas in before reading.
  // ("24h"/"today" read usageHistory, where the row is already written; the
  // flush is a no-op for them and costs one map-size check otherwise.)
  await flushDayRollupQuietly();
  // Same rule as getUsageStats: pending/error rows are log entries, not usage.
  const USAGE_ONLY = `COALESCE(status, 'ok') NOT IN ('pending', 'error')`;
  const now = Date.now();

  const patterns = parseAllowedModels(allowedModels);
  const modelAllowed = (model: string) => matchesModelPatterns(patterns, model);

  // For "today" and "24h", use hourly buckets from usageHistory (already has filterApiKey support)
  if (period === "today") {
    const bucketCount = 24;
    const bucketMs = 3600000;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startTime = startOfDay.getTime();
    const endTime = startTime + bucketCount * bucketMs;
    const labelFn = (ts: number) => new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    const buckets = Array.from({ length: bucketCount }, (_, i) => ({ label: labelFn(startTime + i * bucketMs), tokens: 0, cost: 0, requests: 0 }));

    const sql = filterApiKey
      ? `SELECT timestamp, model, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ? AND apiKey = ? AND status = 'ok'`
      : `SELECT timestamp, model, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ? AND status = 'ok'`;
    const params = filterApiKey ? [new Date(startTime).toISOString(), filterApiKey] : [new Date(startTime).toISOString()];
    const rows = db.all<DbRow>(sql, params);
    for (const r of rows) {
      if (!modelAllowed(String(r.model ?? ""))) continue;
      const t = new Date(String(r.timestamp)).getTime();
      if (t < startTime || t >= endTime) continue;
      const idx = Math.floor((t - startTime) / bucketMs);
      if (idx >= 0 && idx < bucketCount) {
        buckets[idx].tokens += (Number(r.promptTokens) || 0) + (Number(r.completionTokens) || 0);
        buckets[idx].cost += Number(r.cost) || 0;
        buckets[idx].requests += 1;
      }
    }
    return buckets;
  }

  if (period === "24h") {
    const bucketCount = 24;
    const bucketMs = 3600000;
    const labelFn = (ts: number) => new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    const startTime = now - bucketCount * bucketMs;
    const buckets = Array.from({ length: bucketCount }, (_, i) => ({ label: labelFn(startTime + i * bucketMs), tokens: 0, cost: 0, requests: 0 }));

    const sql = filterApiKey
      ? `SELECT timestamp, model, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ? AND apiKey = ? AND status = 'ok'`
      : `SELECT timestamp, model, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ? AND status = 'ok'`;
    const params = filterApiKey ? [new Date(startTime).toISOString(), filterApiKey] : [new Date(startTime).toISOString()];
    const rows = db.all<DbRow>(sql, params);
    for (const r of rows) {
      if (!modelAllowed(String(r.model ?? ""))) continue;
      const t = new Date(String(r.timestamp)).getTime();
      if (t < startTime || t > now) continue;
      const idx = Math.min(Math.floor((t - startTime) / bucketMs), bucketCount - 1);
      buckets[idx].tokens += (Number(r.promptTokens) || 0) + (Number(r.completionTokens) || 0);
      buckets[idx].cost += Number(r.cost) || 0;
      buckets[idx].requests += 1;
    }
    return buckets;
  }

  // For "all", "7d", "30d", "60d" - use daily buckets
  // If filterApiKey is provided, query usageHistory directly to avoid leaking data from other API keys
  // usageDaily contains aggregated data for ALL API keys in its byApiKey field
  const labelFn = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  let startTime: number;
  let bucketCount: number;
  if (period === "all") {
    // For "all", find earliest date from usageHistory
    const earliestRow = db.get<{ minTs: string | null }>(
      `SELECT MIN(timestamp) as minTs FROM usageHistory${filterApiKey ? " WHERE apiKey = ?" : ""}`,
      filterApiKey ? [filterApiKey] : []
    );
    if (!earliestRow?.minTs) return [];
    const earliest = new Date(earliestRow.minTs);
    earliest.setHours(0, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    bucketCount = Math.max(1, Math.round((today.getTime() - earliest.getTime()) / 86400000) + 1);
    startTime = earliest.getTime();
  } else {
    bucketCount = period === "7d" ? 7 : period === "30d" ? 30 : 60;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    startTime = today.getTime() - (bucketCount - 1) * 86400000;
  }

  // Query usageHistory directly when filterApiKey is provided, otherwise use usageDaily for performance
  if (filterApiKey) {
    const sql = `SELECT timestamp, model, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ? AND apiKey = ?`;
    const params = [new Date(startTime).toISOString(), filterApiKey];
    const rows = db.all<DbRow>(sql, params);

    const dayMap: Record<string, ChartBucket> = {};
    for (const r of rows) {
      if (!modelAllowed(String(r.model ?? ""))) continue;
      const d = new Date(String(r.timestamp));
      d.setHours(0, 0, 0, 0);
      const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      dayMap[dateKey] ||= { tokens: 0, cost: 0, requests: 0 };
      dayMap[dateKey].tokens += (Number(r.promptTokens) || 0) + (Number(r.completionTokens) || 0);
      dayMap[dateKey].cost += Number(r.cost) || 0;
      dayMap[dateKey].requests += 1;
    }

    return Array.from({ length: bucketCount }, (_, i) => {
      const d = new Date(startTime + i * 86400000);
      const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const dayData = dayMap[dateKey];
      return {
        label: labelFn(d),
        tokens: dayData ? dayData.tokens : 0,
        cost: dayData ? dayData.cost : 0,
        requests: dayData ? dayData.requests : 0,
      };
    });
  }

  // No filterApiKey - use usageDaily for better performance (admin/global view)
  const dayRows = loadDaysInRange(db, period === "all" ? null : bucketCount);
  const dayMap: Record<string, UsageDay> = {};
  for (const r of dayRows) {
    const dayData = parseJson<UsageDay>(r.data, emptyDay());
    if (patterns === null) {
      // No model restriction - use day totals directly
      dayMap[r.dateKey] = dayData;
    } else {
      // Model restricted - sum only matching models from byModel
      let totalRequests = 0;
      let totalPromptTokens = 0;
      let totalCompletionTokens = 0;
      let totalCachedTokens = 0;
      let totalCost = 0;
      for (const [mk, m] of Object.entries(dayData.byModel || {}) as Array<[string, ModelUsageCounter]>) {
        const rawModel = m.rawModel || mk.split("|")[0];
        if (!modelAllowed(rawModel)) continue;
        totalRequests += m.requests || 0;
        totalPromptTokens += m.promptTokens || 0;
        totalCompletionTokens += m.completionTokens || 0;
        totalCachedTokens += m.cachedTokens || 0;
        totalCost += m.cost || 0;
      }
      if (totalRequests > 0) {
        dayMap[r.dateKey] = {
          requests: totalRequests,
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
          cachedTokens: totalCachedTokens,
          cost: totalCost,
        };
      }
    }
  }

  return Array.from({ length: bucketCount }, (_, i) => {
    const d = new Date(startTime + i * 86400000);
    const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const dayData = dayMap[dateKey];
    return {
      label: labelFn(d),
      tokens: dayData ? (dayData.promptTokens || 0) + (dayData.completionTokens || 0) : 0,
      cost: dayData ? (dayData.cost || 0) : 0,
      requests: dayData ? (dayData.requests || 0) : 0,
    };
  });
}

/**
 * Compact per-day totals for the Overview sparklines (#16) plus a session-
 * scoped activity pulse for the heatmap (#15).
 *
 * The sparklines read `usageDaily`, so an idle day is a real zero - distinct
 * from the chart API, which merges today's live rows. The heatmap buckets the
 * 60 most recent session-scoped requests by local weekday × hour; session
 * scoping matches the rest of the Overview, so a key user sees their own
 * pattern and not the whole server's.
 */
export async function getSparks(period = "30d", filterApiKey = null, allowedModels = "*") {
  const db = await getAdapter();

  const patterns = parseAllowedModels(allowedModels);
  const modelAllowed = (model: string) => matchesModelPatterns(patterns, model);

  const DAYS = { today: 1, "24h": 1, "7d": 7, "30d": 30, "60d": 60, all: 60 }[period] || 30;

  const totals = { requests: [], input: [], output: [], cost: [], cached: [] };
  const rows = db.all<{ dateKey: string; data: string }>(
    `SELECT dateKey, data FROM usageDaily WHERE dateKey >= ? ORDER BY dateKey ASC`,
    [localCutoffKey(DAYS)],
  );
  const byKey: Record<string, UsageDay> = {};
  for (const r of rows) byKey[r.dateKey] = parseJson<UsageDay>(r.data, emptyDay());

  for (let i = DAYS - 1; i >= 0; i -= 1) {
    const key = offsetKey(i);
    const day = byKey[key];
    if (!day) {
      totals.requests.push(0); totals.input.push(0); totals.output.push(0);
      totals.cost.push(0); totals.cached.push(0);
      continue;
    }
    // usageDaily has no top-level cachedTokens - it lives per model bucket.
    const dayCached = (Object.values(day.byModel || {}) as ModelUsageCounter[]).reduce(
      (sum, m) => sum + (Number(m.cachedTokens) || 0), 0,
    );
    if (patterns === null && !filterApiKey) {
      totals.requests.push(Number(day.requests) || 0);
      totals.input.push(Number(day.promptTokens) || 0);
      totals.output.push(Number(day.completionTokens) || 0);
      totals.cost.push(Number(day.cost) || 0);
      totals.cached.push(dayCached);
      continue;
    }
    // Session-scoped: sum only the allowed models from the per-model buckets.
    let req = 0, pin = 0, pout = 0, cost = 0, cached = 0;
    for (const [mk, m] of Object.entries(day.byModel || {}) as Array<[string, ModelUsageCounter]>) {
      const rawModel = m.rawModel || String(mk).split("|")[0];
      if (!modelAllowed(rawModel)) continue;
      req += Number(m.requests) || 0;
      pin += Number(m.promptTokens) || 0;
      pout += Number(m.completionTokens) || 0;
      cost += Number(m.cost) || 0;
      cached += Number(m.cachedTokens) || 0;
    }
    totals.requests.push(req); totals.input.push(pin); totals.output.push(pout);
    totals.cost.push(cost); totals.cached.push(cached);
  }

  // Heatmap source: the most recent rows the session may see. Capped - a
  // heat cell is a traffic pattern, not an audit trail.
  const keyRows = filterApiKey
    ? db.all(
        `SELECT timestamp FROM usageHistory WHERE apiKey = ? ORDER BY id DESC LIMIT 500`,
        [filterApiKey],
      )
    : db.all(`SELECT timestamp FROM usageHistory ORDER BY id DESC LIMIT 500`);
  const heatTimestamps = keyRows.map((r) => r.timestamp);

  return { days: DAYS, totals, heatTimestamps };
}

function toLocalKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function offsetKey(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return toLocalKey(d);
}

function localCutoffKey(n) {
  return offsetKey(n - 1);
}

function formatLogDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * The log table's status cell, in the vocabulary RequestLogger.js renders.
 *
 * It classifies by substring — "PENDING" pulses, "FAILED" is red, "OK" is green
 * — while saveRequestUsage writes the wire-style `ok`/`error`. Left raw, every
 * successful request fell through all three checks and rendered as a pulsing
 * PENDING row, so a finished request looked like it was still in flight forever.
 */
function normalizeLogStatus(status, timestamp) {
  const raw = typeof status === "string" ? status.trim() : "";
  if (!raw) return "-";
  const upper = raw.toUpperCase();
  if (upper.includes("FAILED") || upper === "ERROR") return upper === "ERROR" ? "FAILED" : upper;
  if (upper === "PENDING") {
    // A pending row older than the request timeout has no live request behind
    // it — the process died or the write never completed. Rendering it as
    // PENDING would pulse forever, so surface it as the stale marker instead.
    const startedMs = timestamp ? new Date(timestamp).getTime() : NaN;
    if (Number.isFinite(startedMs) && Date.now() - startedMs > PENDING_TIMEOUT_MS) return "STALE";
    return "PENDING";
  }
  if (upper === "OK" || upper === "SUCCESS" || /^2\d\d/.test(upper)) {
    return upper === "OK" ? "200 OK" : upper;
  }
  return upper;
}

// Request log = the usageHistory table read back (getRecentLogs). Successes land
// there via saveRequestUsage, but FAILURES never do — a failed call has no usage
// to charge, so nothing wrote a row and the dashboard's Request Logs tab showed a
// stream of successes with no trace of what broke. Callers already report every
// failure through this function, so record it: a zero-token usageHistory row is
// exactly what a billed-nothing failed request looks like.
//
// PENDING is the "a request just started" marker chatCore emits before dispatch.
// It is written as its own row so an in-flight request is visible in the log, and
// it is superseded by the terminal write: saveRequestUsage() drops the matching
// open row in the same transaction as it inserts the usage row (see
// clearPendingRow), so a request ends up as exactly one row. A pending row that
// outlives PENDING_TIMEOUT_MS means the process went away mid-request; reading it
// back renders that as STALE rather than pulsing "pending" forever.
export interface RequestLogEntry {
  model?: string | null;
  provider?: string | null;
  connectionId?: string | null;
  tokens?: UsageTokens | null;
  apiKey?: string | null;
  endpoint?: string | null;
  status?: string | null;
  requestId?: string | null;
  /** The name the caller asked for, when it differs from the serving model. */
  requestedModel?: string | null;
}

export async function appendRequestLog({
  model,
  provider,
  connectionId,
  tokens,
  apiKey,
  endpoint,
  status,
  requestId,
  requestedModel,
}: RequestLogEntry = {}): Promise<void> {
  const upper = typeof status === "string" ? status.toUpperCase() : "";
  const isFailure = upper.includes("FAILED");
  const isPending = upper.includes("PENDING");
  if (!isFailure && !isPending) return;

  // A lifecycle row (pending marker, failed call) lands in the same table the
  // live stream reads, and the caller passes the REQUESTED name there — a combo.
  // Without the alias the row carries meta={} and the dashboard shows the combo
  // until the terminal row replaces it, which reads as the model flickering
  // between the real target and the combo name once per request.
  const realModel = requestedModel || model;
  const aliasModelName = requestedModel ? model : undefined;

  try {
    await saveRequestUsage({
      provider: provider || "unknown",
      model: realModel || "unknown",
      requestedModel: aliasModelName,
      connectionId: connectionId || undefined,
      apiKey: undefined,
      endpoint: endpoint || null,
      tokens: tokens || { prompt_tokens: 0, completion_tokens: 0 },
      timestamp: new Date().toISOString(),
      status: isPending ? "pending" : "error",
      // Only the PENDING marker carries the request id. A FAILED row must NOT:
      // the dedupe lookup below matches on `requestId` regardless of status, so
      // an error row tagged with the request's id would suppress the usage row a
      // later combo retry writes for the same request (error rows are written
      // with 0/0 tokens, before any billing). The marker is the row that needs
      // to be found by id — that is the one clearPendingRow deletes.
      requestId: isPending && requestId ? requestId : undefined,
    }, {
      // A start marker or a failed call billed nothing: it belongs in the log,
      // never in token/cost/lifetime totals.
      logOnly: true,
      // The dedupe path collapses duplicate USAGE reports, not distinct
      // lifecycle events, so these rows are always written.
      allowDuplicate: true,
    });
  } catch (e) {
    console.error("[usageRepo] appendRequestLog failed:", e instanceof Error ? e.message : e);
  }
}

/**
 * Drop the open PENDING row a terminal write supersedes.
 * Scoped to the same provider/model/connection and the pending window, so an
 * unrelated older request is never touched. Caller runs this inside the usage
 * transaction.
 *
 * When the caller supplies the request's own id, delete by that instead. The
 * id is an indexed column, so this is a seek; the fallback below cannot use any
 * index (`status`/`provider`/`model`/`connectionId` are all filtered together,
 * and the COALESCE wrappers defeat the single-column indexes anyway) and scans
 * `usageHistory` once per completed request. Measured with a SQL-level probe:
 * 51.7ms for 601 requests at ~2k rows — 86us each, growing with the table,
 * on the write path of every request.
 */
/** The subset of an entry that identifies its open pending row. */
interface PendingRowKey {
  provider?: string | null;
  model?: string | null;
  connectionId?: string | null;
  requestId?: string | number | null;
}

function clearPendingRow(db: ResolvedDbAdapter, { provider, model, connectionId, requestId }: PendingRowKey): void {
  try {
    if (requestId) {
      // `status = 'pending'` keeps this from touching the usage row this same
      // transaction is about to insert under the same id.
      db.run(
        `DELETE FROM usageHistory WHERE requestId = ? AND status = 'pending'`,
        [String(requestId)]
      );
      return;
    }
    const cutoff = new Date(Date.now() - PENDING_TIMEOUT_MS).toISOString();
    db.run(
      `DELETE FROM usageHistory
        WHERE status = 'pending'
          AND timestamp >= ?
          AND COALESCE(provider, '') = COALESCE(?, '')
          AND COALESCE(model, '') = COALESCE(?, '')
          AND COALESCE(connectionId, '') = COALESCE(?, '')`,
      [cutoff, provider || null, model || null, connectionId || null]
    );
  } catch { /* log bookkeeping must never fail a usage write */ }
}

export async function getRecentLogs(limit = 200) {
  try {
    const db = await getAdapter();
    const rows = db.all<DbRow>(
      `SELECT timestamp, provider, model, connectionId, promptTokens, completionTokens, status, tokens, meta FROM usageHistory ORDER BY id DESC LIMIT ?`,
      [limit],
    );
    if (!rows.length) return [];

    const connMap: Record<string, string> = {};
    try {
      const { getProviderConnections } = await import("./connectionsRepo");
      const connections = await getProviderConnections();
      for (const c of connections) if (c) connMap[c.id] = c.name || c.email || "";
    } catch {}

    return rows.map((r) => {
      const connectionId = r.connectionId ? String(r.connectionId) : "";
      const ts = formatLogDate(new Date(String(r.timestamp)));
      const p = String(r.provider ?? "").toUpperCase() || "-";
      // The stored `model` is the name the caller asked for; the real target is
      // in meta. A log line that names the combo claims the combo served it.
      const resolvedName = (parseJson<Record<string, unknown>>(r.meta as string | null, {}) || {}).resolvedModel as string | null | undefined;
      const m = String(resolvedName || r.model || "") || "-";
      const account = connMap[connectionId] || (connectionId ? connectionId.slice(0, 8) : "-");
      const tk = r.tokens ? parseJson<UsageTokens>(r.tokens as string, {}) : {};
      const sent = r.promptTokens != null ? Number(r.promptTokens) : (tk.prompt_tokens ?? "-");
      const received =
        r.completionTokens != null ? Number(r.completionTokens) : (tk.completion_tokens ?? "-");
      return `${ts} | ${m} | ${p} | ${account} | ${sent} | ${received} | ${normalizeLogStatus(r.status, r.timestamp)}`;
    });
  } catch (e) {
    console.error("[usageRepo] getRecentLogs failed:", e instanceof Error ? e.message : e);
    return [];
  }
}
