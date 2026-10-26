import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver";
import { DEFAULT_PERMISSIONS } from "@/lib/auth/permissionPaths";
import {
  keyAccessFromColumns,
  keyAccessToColumns,
  validateKeyAccessInput,
  type KeyAccess,
} from "@/shared/utils/keyAccess";
import type { DbRow, ResolvedDbAdapter } from "../types";
import { normalizeAllowedEndpoints } from "@/shared/constants/keyEndpoints";
// The allowed-model pattern language lives in a dependency-free module of its own:
// the request gate, the /v1/models listing and the usage dashboards all read it, and
// the self-check loads it without dragging in the database driver and uuid. Re-exported
// here so the existing `from "./apiKeysRepo"` importers are unaffected.
import { parseAllowedModels, matchesAllowedModels, buildAllowedModelsSql, applyModelChangesToAllowList } from "./allowedModels";

export { parseAllowedModels, matchesAllowedModels, buildAllowedModelsSql };

export function parsePermissions(permStr: unknown): Record<string, unknown> {
  if (!permStr) return { ...DEFAULT_PERMISSIONS };
  if (typeof permStr === "object") return permStr as Record<string, unknown>;
  try {
    return JSON.parse(permStr as string) as Record<string, unknown>;
  } catch {
    return { ...DEFAULT_PERMISSIONS };
  }
}

/** UTC calendar day (`YYYY-MM-DD`) — the same bucket SQLite's date('now') produces. */
export function utcDayKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/** An API key as the app sees it (booleans resolved, JSON columns parsed). */
export interface ApiKeyRecord {
  id: string;
  key: string;
  name: string;
  machineId: string;
  isActive: boolean;
  createdAt: string;
  tokenLimit: number;
  usedTokens: number;
  limitKind: "tokens" | "requests" | "cost";
  requestLimit: number;
  usedRequests: number;
  resetInterval: string;
  lastResetAt: string | null;
  allowedModels: string;
  allowedEndpoints: string[];
  rpmLimit: number;
  tpmLimit: number;
  dailyCostLimit: number;
  costSpent: number;
  costDay: string;
  expiresAt: string | null;
  systemPrompt: string;
  permissions: Record<string, unknown>;
  createdBy: string;
  access: KeyAccess;
}

/** Raw apiKeys row: SQLite has no booleans, so flags arrive as 0/1. */
interface ApiKeyRow extends DbRow {
  id: string;
  key: string;
  name: string;
  machineId: string;
  isActive?: number | boolean | null;
  createdAt: string;
  tokenLimit?: number | null;
  usedTokens?: number | null;
  limitKind?: string | null;
  requestLimit?: number | string | null;
  usedRequests?: number | string | null;
  resetInterval?: string | null;
  lastResetAt?: string | null;
  allowedModels?: string | null;
  allowedEndpoints?: string | null;
  rpmLimit?: number | null;
  tpmLimit?: number | null;
  dailyCostLimit?: number | string | null;
  costSpent?: number | string | null;
  costDay?: string | null;
  expiresAt?: string | null;
  systemPrompt?: string | null;
  permissions?: string | null;
  createdBy?: string | null;
  accessRestricted?: number | boolean | null;
  accessAllow?: string | null;
}

function rowToKey(row: ApiKeyRow | null | undefined): ApiKeyRecord | null {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    tokenLimit: row.tokenLimit || 0,
    usedTokens: row.usedTokens || 0,
    limitKind: row.limitKind === "cost" || row.limitKind === "requests" ? row.limitKind : "tokens",
    requestLimit: Number(row.requestLimit) || 0,
    usedRequests: Number(row.usedRequests) || 0,
    resetInterval: row.resetInterval || "never",
    lastResetAt: row.lastResetAt || null,
    allowedModels: row.allowedModels || "*",
    allowedEndpoints: normalizeAllowedEndpoints(row.allowedEndpoints),
    rpmLimit: row.rpmLimit || 0,
    tpmLimit: row.tpmLimit || 0,
    dailyCostLimit: Number(row.dailyCostLimit) || 0,
    costSpent: Number(row.costSpent) || 0,
    costDay: row.costDay || "",
    expiresAt: row.expiresAt || null,
    systemPrompt: row.systemPrompt || "",
    permissions: parsePermissions(row.permissions),
    createdBy: row.createdBy || "",
    access: keyAccessFromColumns(row.accessRestricted, row.accessAllow),
  };
}

function normalizeAccess(access: unknown): KeyAccess {
  const result = validateKeyAccessInput(access);
  if (result.ok === false) throw new Error(result.error);
  return result.value;
}

export async function getApiKeys(): Promise<ApiKeyRecord[]> {
  const db = await getAdapter();
  const rows = db.all<ApiKeyRow>(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map((row) => rowToKey(row)).filter((key): key is ApiKeyRecord => key !== null);
}

export async function getApiKeyById(id: string): Promise<ApiKeyRecord | null> {
  const db = await getAdapter();
  const row = db.get<ApiKeyRow>(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

export async function getApiKeyByKey(key: string): Promise<ApiKeyRecord | null> {
  const db = await getAdapter();
  const row = db.get<ApiKeyRow>(`SELECT * FROM apiKeys WHERE key = ?`, [key]);
  return rowToKey(row);
}

export async function createApiKey(
  name: string,
  machineId: string,
  options: Partial<ApiKeyRecord> & { permissions?: unknown } = {}
): Promise<ApiKeyRecord> {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const now = new Date().toISOString();
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    createdAt: now,
    tokenLimit: Number(options.tokenLimit) || 0,
    usedTokens: Number(options.usedTokens) || 0,
    limitKind:
      options.limitKind === "cost" || options.limitKind === "requests"
        ? (options.limitKind as "cost" | "requests")
        : ("tokens" as const),
    requestLimit: Number(options.requestLimit) || 0,
    usedRequests: Number(options.usedRequests) || 0,
    resetInterval: options.resetInterval || "never",
    lastResetAt: options.lastResetAt || now,
    allowedModels: options.allowedModels || "*",
    allowedEndpoints: normalizeAllowedEndpoints(options.allowedEndpoints),
    rpmLimit: Number(options.rpmLimit) || 0,
    tpmLimit: Number(options.tpmLimit) || 0,
    dailyCostLimit: Number(options.dailyCostLimit) || 0,
    costSpent: Number(options.costSpent) || 0,
    costDay: options.costDay || "",
    expiresAt: options.expiresAt || null,
    systemPrompt: options.systemPrompt || "",
    permissions: typeof options.permissions === "object" ? options.permissions : parsePermissions(options.permissions),
    // The caller resolves who is creating the key. It is never inferred here:
    // this module has no session, and reaching for one turned every create into
    // a ReferenceError, which the route reported as a bare 500.
    createdBy: options.createdBy || "",
    access: normalizeAccess(options.access ?? { restricted: false, allow: [] }),
  };
  const permStr = typeof options.permissions === "string" ? options.permissions : JSON.stringify(apiKey.permissions);
  const accessColumns = keyAccessToColumns(apiKey.access);
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, tokenLimit, usedTokens, limitKind, requestLimit, usedRequests, resetInterval, lastResetAt, allowedModels, allowedEndpoints, rpmLimit, tpmLimit, dailyCostLimit, costSpent, costDay, ipWhitelist, expiresAt, systemPrompt, permissions, createdBy, accessRestricted, accessAllow) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      apiKey.id,
      apiKey.key,
      apiKey.name,
      apiKey.machineId,
      1,
      apiKey.createdAt,
      apiKey.tokenLimit,
      apiKey.usedTokens,
      apiKey.limitKind,
      apiKey.requestLimit,
      apiKey.usedRequests,
      apiKey.resetInterval,
      apiKey.lastResetAt,
      apiKey.allowedModels,
      JSON.stringify(apiKey.allowedEndpoints),
      apiKey.rpmLimit,
      apiKey.tpmLimit,
      apiKey.dailyCostLimit,
      apiKey.costSpent,
      apiKey.costDay,
      "",
      apiKey.expiresAt,
      apiKey.systemPrompt,
      permStr,
      apiKey.createdBy,
      accessColumns.accessRestricted,
      accessColumns.accessAllow,
    ]
  );
  invalidateApiKeyCache();
  return apiKey;
}

export async function updateApiKey(
  id: string,
  data: Partial<ApiKeyRecord> & { permissions?: unknown }
): Promise<ApiKeyRecord | null> {
  const db = await getAdapter();
  let result: ApiKeyRecord | null = null;
  db.transaction(() => {
    const row = db.get<ApiKeyRow>(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row), ...data };
    merged.access = normalizeAccess(data.access === undefined ? rowToKey(row).access : data.access);
    const permStr = typeof merged.permissions === "string" ? merged.permissions : JSON.stringify(merged.permissions || {});
    const accessColumns = keyAccessToColumns(merged.access);
    db.run(
      `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ?, tokenLimit = ?, usedTokens = ?, limitKind = ?, requestLimit = ?, usedRequests = ?, resetInterval = ?, lastResetAt = ?, allowedModels = ?, allowedEndpoints = ?, rpmLimit = ?, tpmLimit = ?, dailyCostLimit = ?, costSpent = ?, costDay = ?, ipWhitelist = ?, expiresAt = ?, systemPrompt = ?, permissions = ?, createdBy = ?, accessRestricted = ?, accessAllow = ? WHERE id = ?`,
      [
        merged.key,
        merged.name,
        merged.machineId,
        merged.isActive ? 1 : 0,
        Number(merged.tokenLimit) || 0,
        Number(merged.usedTokens) || 0,
        merged.limitKind === "cost" || merged.limitKind === "requests" ? merged.limitKind : "tokens",
        Number(merged.requestLimit) || 0,
        Number(merged.usedRequests) || 0,
        merged.resetInterval || "never",
        merged.lastResetAt || null,
        merged.allowedModels || "*",
        JSON.stringify(normalizeAllowedEndpoints(merged.allowedEndpoints)),
        Number(merged.rpmLimit) || 0,
        Number(merged.tpmLimit) || 0,
        Number(merged.dailyCostLimit) || 0,
        Number(merged.costSpent) || 0,
        merged.costDay || "",
        "",
        merged.expiresAt || null,
        merged.systemPrompt || "",
        permStr,
        merged.createdBy || "",
        accessColumns.accessRestricted,
        accessColumns.accessAllow,
        id,
      ]
    );
    result = rowToKey(db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]));
  });
  // The key string may have changed and a deactivated key must stop
  // authenticating at once, so clear rather than evict by id.
  invalidateApiKeyCache();
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  invalidateApiKeyCache();
  return (res?.changes ?? 0) > 0;
}

// In-memory sliding window rate limiter state for RPM/TPM per API key
if (!global._apiKeyRateLimits) global._apiKeyRateLimits = {};
const rateLimits = global._apiKeyRateLimits;

// Process-wide memo cache for the api-key list, invalidated on writes so the
// next request re-reads from SQLite instead of serving stale rows.
if (!global._apiKeyListCache) global._apiKeyListCache = null;
export function invalidateApiKeyCache() {
  global._apiKeyListCache = null;
}

function checkRateLimits(key, rpmLimit, tpmLimit) {
  if (rpmLimit <= 0 && tpmLimit <= 0) return true;
  const now = Date.now();
  if (!rateLimits[key]) {
    rateLimits[key] = [];
  }

  // Filter out events older than 60 seconds (1 minute window)
  rateLimits[key] = rateLimits[key].filter((req) => now - req.ts < 60000);
  const recent = rateLimits[key];

  if (rpmLimit > 0 && recent.length >= rpmLimit) {
    return "RPM_EXCEEDED";
  }

  if (tpmLimit > 0) {
    const totalTokensInWindow = recent.reduce((sum, r) => sum + (r.tokens || 0), 0);
    if (totalTokensInWindow >= tpmLimit) {
      return "TPM_EXCEEDED";
    }
  }

  return true;
}

export function recordApiKeyUsageInWindow(key, tokens = 0) {
  if (!key) return;
  const now = Date.now();
  if (!rateLimits[key]) rateLimits[key] = [];
  rateLimits[key].push({ ts: now, tokens: tokens || 0 });
}

/** Patterns of the key used by a request; null when there is no key or it allows all. */
export async function getAllowedModelsOfKey(key) {
 const raw = typeof key === "string" ? key.trim() : "";
 if (!raw) return null;
 try {
 const db = await getAdapter();
 const row = db.get<{ allowedModels?: string | null }>(`SELECT allowedModels FROM apiKeys WHERE key = ?`, [raw]);
 return row ? parseAllowedModels(row.allowedModels) : null;
 } catch {
 return null;
 }
}

/** Every reason `validateApiKey` can reject a request, plus `true` when it passes. */
export type ApiKeyVerdict =
  | true
  | false
  | "KEY_DISABLED"
  | "KEY_EXPIRED"
  | "QUOTA_EXCEEDED"
  | "REQUEST_LIMIT_EXCEEDED"
  | "COST_LIMIT_EXCEEDED"
  | "MODEL_NOT_ALLOWED"
  | "RPM_EXCEEDED"
  | "TPM_EXCEEDED";

export async function validateApiKey(
  key: string,
  requestedModel: string | null = null
): Promise<ApiKeyVerdict> {
  const db = await getAdapter();
  let result: ApiKeyVerdict = false;

  db.transaction(() => {
    const row = db.get<ApiKeyRow>(`SELECT * FROM apiKeys WHERE key = ?`, [key]);
    if (!row) {
      result = false;
      return;
    }
    if (row.isActive !== 1 && row.isActive !== true) {
      // Its own reason code: a switched-off key must not be confused with an unknown one.
      result = "KEY_DISABLED";
      return;
    }

    // Check expiry (#3)
    if (row.expiresAt) {
      const expMs = new Date(row.expiresAt).getTime();
      if (!isNaN(expMs) && Date.now() > expMs) {
        result = "KEY_EXPIRED";
        return;
      }
    }

    const limitKind = row.limitKind === "cost" || row.limitKind === "requests" ? row.limitKind : "tokens";
    const tokenLimit = Number(row.tokenLimit) || 0;
    const requestLimit = Number(row.requestLimit) || 0;
    const dailyCostLimit = Number(row.dailyCostLimit) || 0;
    // Exactly one cap is enforced: the one the owner selected. The other numbers may
    // still be stored (switching back must not lose them) but they never block.
    const activeCap = limitKind === "cost" ? dailyCostLimit : limitKind === "requests" ? requestLimit : tokenLimit;
    let usedTokens = Number(row.usedTokens) || 0;
    let usedRequests = Number(row.usedRequests) || 0;
    const resetInterval: string = row.resetInterval || "never";
    const allowedModels: string = row.allowedModels || "*";
    const nowMs = Date.now();
    let lastResetMs = row.lastResetAt
      ? new Date(row.lastResetAt).getTime()
      : new Date(row.createdAt).getTime();

    if (isNaN(lastResetMs)) lastResetMs = nowMs;

    let shouldReset = false;
    // Cost carries its own day stamp, so only the token and request windows need the
    // interval arithmetic here; a cost key has nothing to reset in this path.
    if (limitKind !== "cost" && activeCap > 0 && resetInterval && resetInterval !== "never") {
      let intervalMs = 0;
      const num = parseInt(resetInterval, 10);
      if (resetInterval.endsWith("m")) {
        intervalMs = num * 60 * 1000;
      } else if (resetInterval.endsWith("h")) {
        intervalMs = num * 60 * 60 * 1000;
      } else if (resetInterval.endsWith("d")) {
        intervalMs = num * 24 * 60 * 60 * 1000;
      }

      if (intervalMs > 0 && nowMs - lastResetMs >= intervalMs) {
        shouldReset = true;
        const periodsPassed = Math.floor((nowMs - lastResetMs) / intervalMs);
        lastResetMs = lastResetMs + periodsPassed * intervalMs;
      }
    }

    if (shouldReset) {
      usedTokens = 0;
      usedRequests = 0;
      const newResetIso = new Date(lastResetMs).toISOString();
      db.run(`UPDATE apiKeys SET usedTokens = 0, usedRequests = 0, lastResetAt = ? WHERE id = ?`, [
        newResetIso,
        row.id,
      ]);
    }

    if (limitKind === "tokens" && tokenLimit > 0 && usedTokens >= tokenLimit) {
      result = "QUOTA_EXCEEDED";
      return;
    }

    if (limitKind === "requests" && requestLimit > 0 && usedRequests >= requestLimit) {
      result = "REQUEST_LIMIT_EXCEEDED";
      return;
    }

    // Daily money cap. The counter is stamped with the UTC day it belongs to, so a
    // stamp from an earlier day means nothing has been spent today yet; without that
    // check a key would stay blocked until something rewrote the row.
    if (limitKind === "cost" && dailyCostLimit > 0) {
      const spentToday = row.costDay === utcDayKey() ? Number(row.costSpent) || 0 : 0;
      if (spentToday >= dailyCostLimit) {
        result = "COST_LIMIT_EXCEEDED";
        return;
      }
    }

    // Check allowed models
    const allowedPatterns = parseAllowedModels(allowedModels);
 if (requestedModel && allowedPatterns) {
      const isAllowed = matchesAllowedModels(allowedPatterns, requestedModel);

      if (!isAllowed) {
        result = "MODEL_NOT_ALLOWED";
        return;
      }
    }

    // Check RPM & TPM rate limits
    const rpmLimit = Number(row.rpmLimit) || 0;
    const tpmLimit = Number(row.tpmLimit) || 0;
    const rateCheck = checkRateLimits(key, rpmLimit, tpmLimit);
    if (rateCheck !== true) {
      result = rateCheck;
      return;
    }

    result = true;
  });

  return result;
}

/**
 * Follow a model deletion or rename through every API key's allowlist.
 *
 * Callers name exactly what disappeared; nothing here scans the model catalog, so
 * an unreachable provider cannot shrink anyone's list. Fail-open by construction:
 * a throw anywhere below leaves every key as it was, and the mutation that
 * triggered this has already been committed.
 */
export async function reconcileAllowedModels({ removed = [], renamed = {} } = {}) {
  if (!removed.length && !Object.keys(renamed).length) {
    return { updated: 0, emptied: [] };
  }
  try {
    const keys = await getApiKeys();
    let updated = 0;
    const emptied = [];

    for (const key of keys) {
      const result = applyModelChangesToAllowList(key.allowedModels, { removed, renamed });
      if (result.emptied) { emptied.push(key.name || key.id); continue; }
      if (!result.changed) continue;
      await updateApiKey(key.id, { allowedModels: result.value });
      updated++;
    }
    return { updated, emptied };
  } catch (err) {
    console.error("[reconcileAllowedModels] failed to follow model change:", err);
    return { updated: 0, emptied: [] };
  }
}
