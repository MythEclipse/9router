// Public API barrel - all DB functions
import { getAdapter } from "./driver";
import { stringifyJson, parseJson } from "./helpers/jsonCol";
import { invalidateSettingsCache } from "./repos/settingsRepo";
import { invalidatePricingCache } from "./repos/pricingRepo";
import { invalidateApiKeyCache } from "./repos/apiKeysRepo";
import { invalidateNodeCache } from "./repos/nodesRepo";
import { keyAccessFromColumns, keyAccessToColumns, validateKeyAccessInput } from "@/shared/utils/keyAccess";
import { KEY_ACCESS_UNRESTRICTED } from "@/shared/constants/keyAccess";
import { normalizeAllowedEndpoints } from "@/shared/constants/keyEndpoints";

// Settings
export {
  getSettings, updateSettings, isCloudEnabled, getCloudUrl, exportSettings,
} from "./repos/settingsRepo";

// Provider connections
export {
  getProviderConnections, getProviderConnectionById,
  createProviderConnection, updateProviderConnection,
  deleteProviderConnection, deleteProviderConnectionsByProvider,
  reorderProviderConnections, cleanupProviderConnections,
} from "./repos/connectionsRepo";

// Provider nodes
export {
  getProviderNodes, getProviderNodeById,
  createProviderNode, updateProviderNode, deleteProviderNode,
} from "./repos/nodesRepo";

// Proxy pools
export {
  getProxyPools, getProxyPoolById,
  createProxyPool, updateProxyPool, deleteProxyPool,
  deleteProxyPools,
} from "./repos/proxyPoolsRepo";

// API keys
export {
  getApiKeys, getApiKeyById, getApiKeyByKey, createApiKey, updateApiKey, deleteApiKey, validateApiKey, recordApiKeyUsageInWindow,
} from "./repos/apiKeysRepo";

// Combos
export {
  getCombos, getComboById, getComboByName,
  createCombo, updateCombo, deleteCombo,
} from "./repos/combosRepo";

// Aliases (model + custom + mitm)
export {
  getModelAliases, setModelAlias, deleteModelAlias,
  getCustomModels, addCustomModel, deleteCustomModel,
  getMitmAlias, setMitmAliasAll,
 } from "./repos/aliasRepo";

 // Model overrides + custom model (studio) virtual models
export {
  getStudioModels, getStudioModel, setStudioModel, deleteStudioModel,
  getModelOverrides, setModelOverride, deleteModelOverride,
} from "./repos/modelEditorRepo";

// Pricing
export {
  getPricing, getPricingForModel, updatePricing, resetPricing, resetAllPricing,
} from "./repos/pricingRepo";

// Disabled models
export {
  getDisabledModels, getDisabledByProvider, disableModels, enableModels,
} from "./repos/disabledModelsRepo";

// Usage
export {
  statsEmitter, trackPendingRequest, getActiveRequests,
  saveRequestUsage, getUsageHistory, getUsageStats, getChartData,
  getSparks, flushDayRollup,
  appendRequestLog, getRecentLogs,
} from "./repos/usageRepo";

// Request details
export {
  saveRequestDetail, getRequestDetails, getRequestDetailById, getDistinctProviders,
} from "./repos/requestDetailsRepo";

// Error Logs
export {
  recordErrorLog, getErrorLogs, clearErrorLogs,
} from "./repos/errorLogRepo";

/** Raw providerConnections row. */
interface ProviderConnectionRow {
  id: string;
  provider: string;
  authType?: string;
  name?: string | null;
  email?: string | null;
  priority?: number | null;
  isActive?: number | null;
  data?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/** Raw providerNodes row. */
interface ProviderNodeRow {
  id: string;
  type?: string | null;
  name?: string | null;
  data?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/** Raw proxyPools row. */
interface ProxyPoolRow {
  id: string;
  isActive?: number | null;
  testStatus?: string | null;
  data?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/** Which sections a backup includes: null = all, array = only those, object = opt-out flags. */
export type ExportScope = string[] | Record<string, boolean> | null;

/** A full database backup. Sections are optional because a scoped export omits them. */
export interface DbExportPayload {
  settings?: unknown;
  providerConnections?: ProviderConnectionBackup[];
  providerNodes?: ProviderNodeBackup[];
  proxyPools?: ProxyPoolBackup[];
  apiKeys?: ApiKeyBackupRow[];
  combos?: ComboBackup[];
  usageHistory?: UsageHistoryBackupRow[];
  usageDaily?: UsageDailyBackupRow[];
  modelAliases?: Record<string, unknown>;
  customModels?: CustomModelBackup[];
  mitmAlias?: Record<string, unknown>;
  modelOverrides?: Record<string, unknown>;
  pricing?: Record<string, unknown>;
  disabledModels?: Record<string, unknown>;
  autoBackup?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * A providerConnections entry inside a backup file.
 *
 * The JSON payload of the row is spread back at the top level on export, so a
 * backup row carries the fixed columns *plus* arbitrary provider-specific keys.
 * `isActive` is a boolean here (the export normalises the 0/1 column), which is
 * why the backup shape is declared separately from the raw row.
 */
export interface ProviderConnectionBackup extends Record<string, unknown> {
  id: string;
  provider?: string;
  authType?: string;
  name?: string | null;
  email?: string | null;
  priority?: number | null;
  isActive?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** A providerNodes entry inside a backup file. */
export interface ProviderNodeBackup extends Record<string, unknown> {
  id: string;
  type?: string | null;
  name?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/** A proxyPools entry inside a backup file. */
export interface ProxyPoolBackup extends Record<string, unknown> {
  id: string;
  isActive?: boolean;
  testStatus?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/** A combos entry inside a backup file. */
export interface ComboBackup {
  id: string;
  name?: string;
  kind?: string;
  models?: unknown[];
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

/** A custom model entry inside a backup file. */
export interface CustomModelBackup extends Record<string, unknown> {
  providerAlias: string;
  id: string;
  type?: string;
}

/** A usageHistory entry inside a backup file. */
export interface UsageHistoryBackupRow extends Record<string, unknown> {
  timestamp?: string;
  provider?: string | null;
  model?: string | null;
  connectionId?: string | null;
  apiKey?: string | null;
  endpoint?: string | null;
  promptTokens?: number;
  completionTokens?: number;
  cost?: number;
  status?: string | null;
  tokens?: unknown;
  meta?: unknown;
}

/** A usageDaily entry inside a backup file. */
export interface UsageDailyBackupRow extends Record<string, unknown> {
  dateKey: string;
  data?: unknown;
}

/** A raw apiKeys table row (columns, not the API view). */
interface ApiKeyRow {
  id: string;
  key?: string;
  name?: string;
  machineId?: string;
  isActive?: number;
  createdAt?: string;
  tokenLimit?: number;
  usedTokens?: number;
  limitKind?: string;
  requestLimit?: number;
  usedRequests?: number;
  resetInterval?: string;
  lastResetAt?: string | null;
  allowedModels?: string;
  allowedEndpoints?: string;
  rpmLimit?: number;
  tpmLimit?: number;
  dailyCostLimit?: number;
  costSpent?: number;
  costDay?: string;
  expiresAt?: string | null;
  systemPrompt?: string;
  permissions?: string;
  createdBy?: string;
  accessRestricted?: number;
  accessAllow?: string;
  [column: string]: unknown;
}

/**
 * An apiKeys entry inside a backup file.
 *
 * Every field is optional: a backup written by an older version omits the
 * columns that did not exist yet, which is exactly why the import falls back to
 * the live row for anything absent.
 */
export interface ApiKeyBackupRow extends Record<string, unknown> {
  id: string;
  key?: string;
  name?: string | null;
  machineId?: string | null;
  isActive?: boolean;
  createdAt?: string;
  tokenLimit?: number;
  usedTokens?: number;
  limitKind?: string;
  requestLimit?: number;
  usedRequests?: number;
  resetInterval?: string;
  lastResetAt?: string | null;
  allowedModels?: string;
  allowedEndpoints?: string[];
  rpmLimit?: number;
  tpmLimit?: number;
  dailyCostLimit?: number;
  costSpent?: number;
  costDay?: string;
  expiresAt?: string | null;
  systemPrompt?: string;
  permissions?: string;
  createdBy?: string;
  access?: unknown;
}

/** Progress callback for the progressive import. */
export interface ImportProgress {
  done: number;
  total: number;
  percent: number;
  currentSection: string | null;
}

// Export/import full DB
export async function exportDb(options: ExportScope = null): Promise<DbExportPayload> {
  const db = await getAdapter();
  const { exportSettings } = await import("./repos/settingsRepo");

  const isIncluded = (key: string): boolean => {
    if (!options) return true;
    if (Array.isArray(options)) return options.length === 0 || options.includes(key);
    if (typeof options === "object") return options[key] !== false;
    return true;
  };

  const out: DbExportPayload = {};

  if (isIncluded("settings")) {
    out.settings = await exportSettings();
  }
  if (isIncluded("providers")) {
    out.providerConnections = db.all<ProviderConnectionRow>(`SELECT * FROM providerConnections`).map((r) => ({ ...parseJson<Record<string, unknown>>(r.data, {}), id: r.id, provider: r.provider, authType: r.authType, name: r.name, email: r.email, priority: r.priority, isActive: r.isActive === 1, createdAt: r.createdAt, updatedAt: r.updatedAt }));
    out.providerNodes = db.all<ProviderNodeRow>(`SELECT * FROM providerNodes`).map((r) => ({ ...parseJson<Record<string, unknown>>(r.data, {}), id: r.id, type: r.type, name: r.name, createdAt: r.createdAt, updatedAt: r.updatedAt }));
    out.proxyPools = db.all<ProxyPoolRow>(`SELECT * FROM proxyPools`).map((r) => ({ ...parseJson<Record<string, unknown>>(r.data, {}), id: r.id, isActive: r.isActive === 1, testStatus: r.testStatus, createdAt: r.createdAt, updatedAt: r.updatedAt }));
  }
  if (isIncluded("apiKeys")) {
    out.apiKeys = db.all<ApiKeyRow>(`SELECT * FROM apiKeys`).map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      machineId: r.machineId,
      isActive: r.isActive === 1,
      createdAt: r.createdAt,
      tokenLimit: r.tokenLimit,
      usedTokens: r.usedTokens,
      limitKind: r.limitKind || "tokens",
      requestLimit: Number(r.requestLimit) || 0,
      usedRequests: Number(r.usedRequests) || 0,
      resetInterval: r.resetInterval,
      lastResetAt: r.lastResetAt,
      allowedModels: r.allowedModels,
      allowedEndpoints: normalizeAllowedEndpoints(r.allowedEndpoints),
      rpmLimit: r.rpmLimit,
      tpmLimit: r.tpmLimit,
      // The cap is configuration and belongs in a backup; the counter beside it is
      // runtime state, carried along so a restore does not silently reset spend.
      dailyCostLimit: Number(r.dailyCostLimit) || 0,
      costSpent: Number(r.costSpent) || 0,
      costDay: r.costDay || "",
      expiresAt: r.expiresAt || null,
      systemPrompt: r.systemPrompt || "",
      permissions: r.permissions || "",
      createdBy: r.createdBy || "",
      access: keyAccessFromColumns(r.accessRestricted, r.accessAllow),
    }));
  }
  if (isIncluded("combos")) {
    out.combos = db.all<{ id: string; name: string; kind?: string; models?: string | null; createdAt?: string; updatedAt?: string }>(`SELECT * FROM combos`).map((r) => ({ id: r.id, name: r.name, kind: r.kind, models: parseJson<unknown[]>(r.models, []), createdAt: r.createdAt, updatedAt: r.updatedAt }));
  }
  if (isIncluded("usage")) {
    out.usageHistory = db.all(`SELECT * FROM usageHistory ORDER BY id`);
    out.usageDaily = db.all(`SELECT * FROM usageDaily`);
  }
  if (isIncluded("customModels")) {
    out.modelAliases = {};
    out.customModels = [];
    out.mitmAlias = {};
    for (const r of db.all<{ key: string; value: string }>(`SELECT key, value FROM kv WHERE scope = 'modelAliases'`)) out.modelAliases[r.key] = parseJson(r.value);
    for (const r of db.all<{ key: string; value: string }>(`SELECT key, value FROM kv WHERE scope = 'customModels'`)) out.customModels.push(parseJson<CustomModelBackup>(r.value));
    for (const r of db.all<{ key: string; value: string }>(`SELECT key, value FROM kv WHERE scope = 'mitmAlias'`)) out.mitmAlias[r.key] = parseJson(r.value);
  }
  if (isIncluded("pricing")) {
    out.modelOverrides = {};
    out.pricing = {};
    out.disabledModels = {};
    for (const r of db.all<{ key: string; value: string }>(`SELECT key, value FROM kv WHERE scope = 'pricing'`)) out.pricing[r.key] = parseJson(r.value);
    for (const r of db.all<{ key: string; value: string }>(`SELECT key, value FROM kv WHERE scope = 'modelOverrides'`)) out.modelOverrides[r.key] = parseJson(r.value);
    for (const r of db.all<{ key: string; value: string }>(`SELECT key, value FROM kv WHERE scope = 'disabledModels'`)) out.disabledModels[r.key] = parseJson(r.value, []);
  }
  if (isIncluded("autoBackup")) {
    out.autoBackup = {};
    for (const r of db.all<{ key: string; value: string }>(`SELECT key, value FROM kv WHERE scope = 'autoBackup'`)) out.autoBackup[r.key] = parseJson(r.value);
  }

  return out;
}

export async function getDbSummary() {
  const sectionMeta = {
    settings: { label: "Settings & System Config", keys: ["settings"], default: true, isHeavy: false },
    providers: { label: "Provider Connections & Custom Nodes", keys: ["providerConnections", "providerNodes", "proxyPools"], default: true, isHeavy: false },
    apiKeys: { label: "API Keys & Quota Limits", keys: ["apiKeys"], default: true, isHeavy: false },
    combos: { label: "Combos & Custom Routing", keys: ["combos"], default: true, isHeavy: false },
    customModels: { label: "Custom Models & Aliases", keys: ["customModels", "modelAliases", "mitmAlias"], default: true, isHeavy: false },
    pricing: { label: "Pricing & Model Overrides", keys: ["pricing", "modelOverrides", "disabledModels"], default: true, isHeavy: false },
    usage: { label: "Usage History & Logs", keys: ["usageHistory", "usageDaily"], default: false, isHeavy: true },
  };

  const sections = {};
  let totalBytes = 0;

  for (const [secKey, meta] of Object.entries(sectionMeta)) {
    const data = await exportDb([secKey]);
    const jsonStr = JSON.stringify(data);
    const bytes = Buffer.byteLength(jsonStr, "utf8");

    let count = 0;
    for (const k of meta.keys) {
      const val = data[k];
      if (Array.isArray(val)) count += val.length;
      else if (val && typeof val === "object") count += Object.keys(val).length;
    }

    sections[secKey] = {
      key: secKey,
      label: meta.label,
      bytes,
      count,
      default: meta.default,
      isHeavy: meta.isHeavy,
    };
    totalBytes += bytes;
  }

  return { sections, totalBytes };
}

export async function importDb(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid database payload");
  }
  const db = await getAdapter();

  // Snapshot existing apiKeys BEFORE wiping, so we can fill in missing fields from backup
  const existingApiKeys: Record<string, ApiKeyRow> = {};
  for (const r of db.all<ApiKeyRow>(`SELECT * FROM apiKeys`)) {
    existingApiKeys[r.id] = r;
  }

  db.transaction(() => {
    // Selectively wipe and restore only sections present in payload (allows partial backups & backward compatibility)
    if (payload.settings !== undefined) {
      db.run(`DELETE FROM settings`);
      db.run(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, [stringifyJson(payload.settings)]);
    }

    if (payload.providerConnections !== undefined) {
      db.run(`DELETE FROM providerConnections`);
      for (const c of payload.providerConnections || []) {
        const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = c;
        db.run(
          `INSERT OR REPLACE INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, provider, authType || "oauth", name || null, email || null, priority || null, isActive === false ? 0 : 1, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
        );
      }
    }

    if (payload.providerNodes !== undefined) {
      db.run(`DELETE FROM providerNodes`);
      for (const n of payload.providerNodes || []) {
        const { id, type, name, createdAt, updatedAt, ...rest } = n;
        db.run(
          `INSERT OR REPLACE INTO providerNodes(id, type, name, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
          [id, type || null, name || null, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
        );
      }
    }

    if (payload.proxyPools !== undefined) {
      db.run(`DELETE FROM proxyPools`);
      for (const p of payload.proxyPools || []) {
        const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
        db.run(
          `INSERT OR REPLACE INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
          [id, isActive === false ? 0 : 1, testStatus || "unknown", stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
        );
      }
    }

    if (payload.apiKeys !== undefined) {
      db.run(`DELETE FROM apiKeys`);
      for (const k of payload.apiKeys || []) {
        const prev: Partial<ApiKeyRow> = existingApiKeys[k.id] ?? {};
        const tokenLimit = k.tokenLimit !== undefined ? Number(k.tokenLimit) : (prev.tokenLimit !== undefined ? Number(prev.tokenLimit) : 0);
        const usedTokens = k.usedTokens !== undefined ? Number(k.usedTokens) : (prev.usedTokens !== undefined ? Number(prev.usedTokens) : 0);
        const limitKind = k.limitKind !== undefined ? k.limitKind : (prev.limitKind || "tokens");
        const requestLimit = k.requestLimit !== undefined ? Number(k.requestLimit) : (prev.requestLimit !== undefined ? Number(prev.requestLimit) : 0);
        const usedRequests = k.usedRequests !== undefined ? Number(k.usedRequests) : (prev.usedRequests !== undefined ? Number(prev.usedRequests) : 0);
        const resetInterval = k.resetInterval !== undefined ? k.resetInterval : (prev.resetInterval || "never");
        const lastResetAt = k.lastResetAt !== undefined ? k.lastResetAt : (prev.lastResetAt || null);
        const allowedModels = k.allowedModels !== undefined ? k.allowedModels : (prev.allowedModels || "*");
        const allowedEndpoints = JSON.stringify(normalizeAllowedEndpoints(
          k.allowedEndpoints ?? prev.allowedEndpoints,
        ));
        const rpmLimit = k.rpmLimit !== undefined ? Number(k.rpmLimit) : (prev.rpmLimit !== undefined ? Number(prev.rpmLimit) : 0);
        const tpmLimit = k.tpmLimit !== undefined ? Number(k.tpmLimit) : (prev.tpmLimit !== undefined ? Number(prev.tpmLimit) : 0);
        // A backup written before the cost cap existed carries none of these, so the
        // live counter wins over an absent field instead of being zeroed by the restore.
        const dailyCostLimit = k.dailyCostLimit !== undefined ? Number(k.dailyCostLimit) : (prev.dailyCostLimit !== undefined ? Number(prev.dailyCostLimit) : 0);
        const costSpent = k.costSpent !== undefined ? Number(k.costSpent) : (prev.costSpent !== undefined ? Number(prev.costSpent) : 0);
        const costDay = k.costDay !== undefined ? k.costDay : (prev.costDay || "");
        // The whitelist feature is gone; the column survives, so a restore must
        // still pass a value for it.
        const ipWhitelist = "";
        const expiresAt = k.expiresAt !== undefined ? k.expiresAt : (prev.expiresAt || null);
        const systemPrompt = k.systemPrompt !== undefined ? k.systemPrompt : (prev.systemPrompt || "");
        const permissions = k.permissions !== undefined ? k.permissions : (prev.permissions || "");
        const createdBy = k.createdBy !== undefined ? k.createdBy : (prev.createdBy || "");
        const accessInput = k.access === undefined ? KEY_ACCESS_UNRESTRICTED : k.access;
        const accessResult = validateKeyAccessInput(accessInput);
        if (accessResult.ok === false) throw new Error(accessResult.error);
        const accessColumns = keyAccessToColumns(accessResult.value);

        db.run(
          `INSERT OR REPLACE INTO apiKeys(id, key, name, machineId, isActive, createdAt, tokenLimit, usedTokens, limitKind, requestLimit, usedRequests, resetInterval, lastResetAt, allowedModels, allowedEndpoints, rpmLimit, tpmLimit, dailyCostLimit, costSpent, costDay, ipWhitelist, expiresAt, systemPrompt, permissions, createdBy, accessRestricted, accessAllow) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            k.id,
            k.key,
            k.name || null,
            k.machineId || null,
            k.isActive === false ? 0 : 1,
            k.createdAt || new Date().toISOString(),
            tokenLimit,
            usedTokens,
            limitKind,
            requestLimit,
            usedRequests,
            resetInterval,
            lastResetAt,
            allowedModels,
            allowedEndpoints,
            rpmLimit,
            tpmLimit,
            dailyCostLimit,
            costSpent,
            costDay,
            ipWhitelist,
            expiresAt,
            systemPrompt,
            permissions,
            createdBy,
            accessColumns.accessRestricted,
            accessColumns.accessAllow,
          ]
        );
      }
    }

    if (payload.combos !== undefined) {
      db.run(`DELETE FROM combos`);
      for (const c of payload.combos || []) {
        db.run(
          `INSERT OR REPLACE INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
          [c.id, c.name, c.kind || null, stringifyJson(c.models || []), c.createdAt || new Date().toISOString(), c.updatedAt || new Date().toISOString()]
        );
      }
    }

    if (payload.usageHistory !== undefined) {
      db.run(`DELETE FROM usageHistory`);
      for (const h of payload.usageHistory || []) {
        db.run(
          `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            h.timestamp || new Date().toISOString(),
            h.provider || null,
            h.model || null,
            h.connectionId || null,
            h.apiKey || null,
            h.endpoint || null,
            h.promptTokens || 0,
            h.completionTokens || 0,
            h.cost || 0,
            h.status || null,
            h.tokens || null,
            h.meta || null,
          ]
        );
      }
    }

    if (payload.usageDaily !== undefined) {
      db.run(`DELETE FROM usageDaily`);
      for (const d of payload.usageDaily || []) {
        db.run(
          `INSERT OR REPLACE INTO usageDaily(dateKey, data) VALUES(?, ?)`,
          [d.dateKey, typeof d.data === "string" ? d.data : stringifyJson(d.data)]
        );
      }
    }

    if (payload.modelAliases !== undefined) {
      db.run(`DELETE FROM kv WHERE scope = 'modelAliases'`);
      for (const [a, m] of Object.entries(payload.modelAliases || {})) {
        db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)`, [a, stringifyJson(m)]);
      }
    }

    if (payload.customModels !== undefined) {
      db.run(`DELETE FROM kv WHERE scope = 'customModels'`);
      for (const m of payload.customModels || []) {
        const k = `${m.providerAlias}|${m.id}|${m.type || "llm"}`;
        db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, stringifyJson(m)]);
      }
    }

    if (payload.mitmAlias !== undefined) {
      db.run(`DELETE FROM kv WHERE scope = 'mitmAlias'`);
      for (const [tool, mappings] of Object.entries(payload.mitmAlias || {})) {
        db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('mitmAlias', ?, ?)`, [tool, stringifyJson(mappings || {})]);
      }
    }
    if (payload.pricing !== undefined) {
      db.run(`DELETE FROM kv WHERE scope = 'pricing'`);
      for (const [provider, models] of Object.entries(payload.pricing || {})) {
        db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('pricing', ?, ?)`, [provider, stringifyJson(models || {})]);
      }
    }

    if (payload.modelOverrides !== undefined) {
      db.run(`DELETE FROM kv WHERE scope = 'modelOverrides'`);
      for (const [k, v] of Object.entries(payload.modelOverrides || {})) {
        db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('modelOverrides', ?, ?)`, [k, stringifyJson(v)]);
      }
    }

    if (payload.disabledModels !== undefined) {
      db.run(`DELETE FROM kv WHERE scope = 'disabledModels'`);
      for (const [provider, ids] of Object.entries(payload.disabledModels || {})) {
        db.run(`INSERT INTO kv(scope, key, value) VALUES('disabledModels', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`, [provider, stringifyJson(ids || [])]);
      }
    }


    // autoBackup rides in its own KV scope. Only touch it when the backup actually
    // carries the section: an old or partial backup must not reset the schedule.
    if (payload.autoBackup !== undefined) {
      db.run(`DELETE FROM kv WHERE scope = 'autoBackup'`);
      for (const [key, value] of Object.entries(payload.autoBackup || {})) {
        db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('autoBackup', ?, ?)`, [key, stringifyJson(value)]);
      }
    }
  });

  // Settings, pricing and api-key caches are process-wide memos over rows this
  // call just rewrote. Without clearing them, a restore returns the freshly
  // imported data in its OWN response while the next request keeps serving
  // pre-import values — for api keys that means a key the import just deleted
  // still authenticating.
  invalidateSettingsCache();
  invalidatePricingCache();
  invalidateApiKeyCache();
  invalidateNodeCache();

  return await exportDb();
}

// Progressive variant of importDb used by background import jobs. Same restore
// logic split into one transaction per section, with a progress callback and a
// macrotask yield between sections so the event loop stays responsive.
// importDb and exportDb above are intentionally left unchanged.
export async function importDbProgressive(
  payload: DbExportPayload,
  onProgress?: (progress: ImportProgress) => void
) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid database payload");
  }
  const db = await getAdapter();

  // Snapshot existing apiKeys BEFORE wiping, so we can fill in missing fields from backup
  const existingApiKeys = {};
  for (const r of db.all<ApiKeyRow>(`SELECT * FROM apiKeys`)) {
    existingApiKeys[r.id] = r;
  }

  const has = (key: string): boolean => payload[key] !== undefined;
  const stageNames: Array<[string, string[]]> = [
    ["settings", ["settings"]],
    ["providers", ["providerConnections", "providerNodes", "proxyPools"]],
    ["apiKeys", ["apiKeys"]],
    ["combos", ["combos"]],
    ["usage", ["usageHistory", "usageDaily"]],
    ["customModels", ["modelAliases", "customModels", "mitmAlias"]],
    ["pricing", ["pricing", "modelOverrides", "disabledModels"]],
    ["autoBackup", ["autoBackup"]],
  ];
  const stages = stageNames.filter(([, keys]) => keys.some(has));
  const total = stages.length;
  let done = 0;

  const emit = (currentSection) => {
    if (typeof onProgress === "function") {
      onProgress({
        done,
        total,
        percent: total === 0 ? 100 : Math.round((done / total) * 100),
        currentSection,
      });
    }
  };

  const yieldToEventLoop = () => new Promise((resolve) => {
    if (typeof setImmediate === "function") setImmediate(resolve);
    else setTimeout(resolve, 0);
  });

  const finishStage = async (name, index) => {
    done += 1;
    emit(index + 1 < stages.length ? stages[index + 1][0] : "done");
    await yieldToEventLoop();
  };

  if (total === 0) {
    emit("done");
    return await exportDb();
  }
  emit(stages[0][0]);

  if (has("settings")) {
    db.transaction(() => {
      db.run(`DELETE FROM settings`);
      db.run(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, [stringifyJson(payload.settings)]);
    });
    await finishStage("settings", stages.findIndex(([name]) => name === "settings"));
  }

  if (has("providerConnections") || has("providerNodes") || has("proxyPools")) {
    db.transaction(() => {
      if (payload.providerConnections !== undefined) {
        db.run(`DELETE FROM providerConnections`);
        for (const c of payload.providerConnections || []) {
          const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = c;
          db.run(
            `INSERT OR REPLACE INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, provider, authType || "oauth", name || null, email || null, priority || null, isActive === false ? 0 : 1, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
          );
        }
      }

      if (payload.providerNodes !== undefined) {
        db.run(`DELETE FROM providerNodes`);
        for (const n of payload.providerNodes || []) {
          const { id, type, name, createdAt, updatedAt, ...rest } = n;
          db.run(
            `INSERT OR REPLACE INTO providerNodes(id, type, name, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
            [id, type || null, name || null, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
          );
        }
      }

      if (payload.proxyPools !== undefined) {
        db.run(`DELETE FROM proxyPools`);
        for (const p of payload.proxyPools || []) {
          const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
          db.run(
            `INSERT OR REPLACE INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
            [id, isActive === false ? 0 : 1, testStatus || "unknown", stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
          );
        }
      }
    });
    await finishStage("providers", stages.findIndex(([name]) => name === "providers"));
  }

  if (has("apiKeys")) {
    db.transaction(() => {
      db.run(`DELETE FROM apiKeys`);
      for (const k of payload.apiKeys || []) {
        const prev: Partial<ApiKeyRow> = existingApiKeys[k.id] ?? {};
        const tokenLimit = k.tokenLimit !== undefined ? Number(k.tokenLimit) : (prev.tokenLimit !== undefined ? Number(prev.tokenLimit) : 0);
        const usedTokens = k.usedTokens !== undefined ? Number(k.usedTokens) : (prev.usedTokens !== undefined ? Number(prev.usedTokens) : 0);
        const limitKind = k.limitKind !== undefined ? k.limitKind : (prev.limitKind || "tokens");
        const requestLimit = k.requestLimit !== undefined ? Number(k.requestLimit) : (prev.requestLimit !== undefined ? Number(prev.requestLimit) : 0);
        const usedRequests = k.usedRequests !== undefined ? Number(k.usedRequests) : (prev.usedRequests !== undefined ? Number(prev.usedRequests) : 0);
        const resetInterval = k.resetInterval !== undefined ? k.resetInterval : (prev.resetInterval || "never");
        const lastResetAt = k.lastResetAt !== undefined ? k.lastResetAt : (prev.lastResetAt || null);
        const allowedModels = k.allowedModels !== undefined ? k.allowedModels : (prev.allowedModels || "*");
        const allowedEndpoints = JSON.stringify(normalizeAllowedEndpoints(
          k.allowedEndpoints ?? prev.allowedEndpoints,
        ));
        const rpmLimit = k.rpmLimit !== undefined ? Number(k.rpmLimit) : (prev.rpmLimit !== undefined ? Number(prev.rpmLimit) : 0);
        const tpmLimit = k.tpmLimit !== undefined ? Number(k.tpmLimit) : (prev.tpmLimit !== undefined ? Number(prev.tpmLimit) : 0);
        // A backup written before the cost cap existed carries none of these, so the
        // live counter wins over an absent field instead of being zeroed by the restore.
        const dailyCostLimit = k.dailyCostLimit !== undefined ? Number(k.dailyCostLimit) : (prev.dailyCostLimit !== undefined ? Number(prev.dailyCostLimit) : 0);
        const costSpent = k.costSpent !== undefined ? Number(k.costSpent) : (prev.costSpent !== undefined ? Number(prev.costSpent) : 0);
        const costDay = k.costDay !== undefined ? k.costDay : (prev.costDay || "");
        // The whitelist feature is gone; the column survives, so a restore must
        // still pass a value for it.
        const ipWhitelist = "";
        const expiresAt = k.expiresAt !== undefined ? k.expiresAt : (prev.expiresAt || null);
        const systemPrompt = k.systemPrompt !== undefined ? k.systemPrompt : (prev.systemPrompt || "");
        const permissions = k.permissions !== undefined ? k.permissions : (prev.permissions || "");
        const createdBy = k.createdBy !== undefined ? k.createdBy : (prev.createdBy || "");

        db.run(
          `INSERT OR REPLACE INTO apiKeys(id, key, name, machineId, isActive, createdAt, tokenLimit, usedTokens, limitKind, requestLimit, usedRequests, resetInterval, lastResetAt, allowedModels, allowedEndpoints, rpmLimit, tpmLimit, dailyCostLimit, costSpent, costDay, ipWhitelist, expiresAt, systemPrompt, permissions, createdBy) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            k.id,
            k.key,
            k.name || null,
            k.machineId || null,
            k.isActive === false ? 0 : 1,
            k.createdAt || new Date().toISOString(),
            tokenLimit,
            usedTokens,
            limitKind,
            requestLimit,
            usedRequests,
            resetInterval,
            lastResetAt,
            allowedModels,
            allowedEndpoints,
            rpmLimit,
            tpmLimit,
            dailyCostLimit,
            costSpent,
            costDay,
            ipWhitelist,
            expiresAt,
            systemPrompt,
            permissions,
            createdBy,
          ]
        );
      }
    });
    await finishStage("apiKeys", stages.findIndex(([name]) => name === "apiKeys"));
  }

  if (has("combos")) {
    db.transaction(() => {
      db.run(`DELETE FROM combos`);
      for (const c of payload.combos || []) {
        db.run(
          `INSERT OR REPLACE INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
          [c.id, c.name, c.kind || null, stringifyJson(c.models || []), c.createdAt || new Date().toISOString(), c.updatedAt || new Date().toISOString()]
        );
      }
    });
    await finishStage("combos", stages.findIndex(([name]) => name === "combos"));
  }

  if (has("usageHistory") || has("usageDaily")) {
    db.transaction(() => {
      if (payload.usageHistory !== undefined) {
        db.run(`DELETE FROM usageHistory`);
        for (const h of payload.usageHistory || []) {
          db.run(
            `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              h.timestamp || new Date().toISOString(),
              h.provider || null,
              h.model || null,
              h.connectionId || null,
              h.apiKey || null,
              h.endpoint || null,
              h.promptTokens || 0,
              h.completionTokens || 0,
              h.cost || 0,
              h.status || null,
              h.tokens || null,
              h.meta || null,
            ]
          );
        }
      }

      if (payload.usageDaily !== undefined) {
        db.run(`DELETE FROM usageDaily`);
        for (const d of payload.usageDaily || []) {
          db.run(
            `INSERT OR REPLACE INTO usageDaily(dateKey, data) VALUES(?, ?)`,
            [d.dateKey, typeof d.data === "string" ? d.data : stringifyJson(d.data)]
          );
        }
      }
    });
    await finishStage("usage", stages.findIndex(([name]) => name === "usage"));
  }

  if (has("modelAliases") || has("customModels") || has("mitmAlias")) {
    db.transaction(() => {
      if (payload.modelAliases !== undefined) {
        db.run(`DELETE FROM kv WHERE scope = 'modelAliases'`);
        for (const [a, m] of Object.entries(payload.modelAliases || {})) {
          db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)`, [a, stringifyJson(m)]);
        }
      }

      if (payload.customModels !== undefined) {
        db.run(`DELETE FROM kv WHERE scope = 'customModels'`);
        for (const m of payload.customModels || []) {
          const k = `${m.providerAlias}|${m.id}|${m.type || "llm"}`;
          db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, stringifyJson(m)]);
        }
      }

      if (payload.mitmAlias !== undefined) {
        db.run(`DELETE FROM kv WHERE scope = 'mitmAlias'`);
        for (const [tool, mappings] of Object.entries(payload.mitmAlias || {})) {
          db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('mitmAlias', ?, ?)`, [tool, stringifyJson(mappings || {})]);
        }
      }
    });
    await finishStage("customModels", stages.findIndex(([name]) => name === "customModels"));
  }

  if (has("pricing") || has("modelOverrides") || has("disabledModels")) {
    db.transaction(() => {
      if (payload.pricing !== undefined) {
        db.run(`DELETE FROM kv WHERE scope = 'pricing'`);
        for (const [provider, models] of Object.entries(payload.pricing || {})) {
          db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('pricing', ?, ?)`, [provider, stringifyJson(models || {})]);
        }
      }

      if (payload.modelOverrides !== undefined) {
        db.run(`DELETE FROM kv WHERE scope = 'modelOverrides'`);
        for (const [k, v] of Object.entries(payload.modelOverrides || {})) {
          db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('modelOverrides', ?, ?)`, [k, stringifyJson(v)]);
        }
      }

      if (payload.disabledModels !== undefined) {
        db.run(`DELETE FROM kv WHERE scope = 'disabledModels'`);
        for (const [provider, ids] of Object.entries(payload.disabledModels || {})) {
          db.run(`INSERT INTO kv(scope, key, value) VALUES('disabledModels', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`, [provider, stringifyJson(ids || [])]);
        }
      }
    });
    await finishStage("pricing", stages.findIndex(([name]) => name === "pricing"));
  }

  if (has("autoBackup")) {
    db.transaction(() => {
      db.run(`DELETE FROM kv WHERE scope = 'autoBackup'`);
      for (const [key, value] of Object.entries(payload.autoBackup || {})) {
        db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('autoBackup', ?, ?)`, [key, stringifyJson(value)]);
      }
    });
    await finishStage("autoBackup", stages.findIndex(([name]) => name === "autoBackup"));
  }

  return await exportDb();
}

// Eager init helper (optional)
export async function initDb() {
  await getAdapter();
}