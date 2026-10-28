// Public API barrel - all DB functions
import { getAdapter } from "./driver.ts";
import { stringifyJson, parseJson } from "./helpers/jsonCol.ts";
import { invalidateSettingsCache } from "./repos/settingsRepo.ts";
import { invalidatePricingCache } from "./repos/pricingRepo.ts";
import { invalidateApiKeyCache } from "./repos/apiKeysRepo.ts";
import { invalidateNodeCache } from "./repos/nodesRepo.ts";
import { keyAccessFromColumns, keyAccessToColumns, validateKeyAccessInput } from "@/shared/utils/keyAccess";
import { KEY_ACCESS_UNRESTRICTED } from "@/shared/constants/keyAccess";
import { normalizeAllowedEndpoints } from "@/shared/constants/keyEndpoints";
import { sectionsPresent } from "./restoreSections.ts";

// Settings
export {
  getSettings, updateSettings, isCloudEnabled, getCloudUrl, exportSettings,
} from "./repos/settingsRepo.ts";

// Provider connections
export {
  getProviderConnections, getProviderConnectionById,
  createProviderConnection, updateProviderConnection,
  deleteProviderConnection, deleteProviderConnectionsByProvider,
  reorderProviderConnections, cleanupProviderConnections,
} from "./repos/connectionsRepo.ts";

// Provider nodes
export {
  getProviderNodes, getProviderNodeById,
  createProviderNode, updateProviderNode, deleteProviderNode,
} from "./repos/nodesRepo.ts";

// Proxy pools
export {
  getProxyPools, getProxyPoolById,
  createProxyPool, updateProxyPool, deleteProxyPool,
  deleteProxyPools,
} from "./repos/proxyPoolsRepo.ts";

// API keys
export {
  getApiKeys, getApiKeyById, getApiKeyByKey, createApiKey, updateApiKey, deleteApiKey, validateApiKey, recordApiKeyUsageInWindow,
} from "./repos/apiKeysRepo.ts";

// Combos
export {
  getCombos, getComboById, getComboByName,
  createCombo, updateCombo, deleteCombo,
} from "./repos/combosRepo.ts";

// Aliases (model + custom + mitm)
export {
  getModelAliases, setModelAlias, deleteModelAlias,
  getCustomModels, addCustomModel, deleteCustomModel,
  getMitmAlias, setMitmAliasAll,
 } from "./repos/aliasRepo.ts";

 // Model overrides + custom model (studio) virtual models
export {
  getStudioModels, getStudioModel, setStudioModel, deleteStudioModel,
  getModelOverrides, setModelOverride, deleteModelOverride,
} from "./repos/modelEditorRepo.ts";

// Pricing
export {
  getPricing, getPricingForModel, updatePricing, resetPricing, resetAllPricing,
} from "./repos/pricingRepo.ts";

// Disabled models
export {
  getDisabledModels, getDisabledByProvider, disableModels, enableModels,
} from "./repos/disabledModelsRepo.ts";

// Usage
export {
  statsEmitter, trackPendingRequest, getActiveRequests,
  saveRequestUsage, getUsageHistory, getUsageStats, getChartData,
  getSparks, flushDayRollup,
  appendRequestLog, getRecentLogs,
} from "./repos/usageRepo.ts";

// Request details
export {
  saveRequestDetail, getRequestDetails, getRequestDetailById, getDistinctProviders,
} from "./repos/requestDetailsRepo.ts";

// Error Logs
export {
  recordErrorLog, getErrorLogs, clearErrorLogs,
} from "./repos/errorLogRepo.ts";

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
  const { exportSettings } = await import("./repos/settingsRepo.ts");

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

  const context = { existingApiKeys };
  db.transaction(() => {
    // Only sections the backup carries are touched, so a partial or older backup
    // restores what it holds and leaves everything else alone.
    for (const section of sectionsPresent(payload)) {
      section.restore(db, payload, context);
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

  const context = { existingApiKeys };
  const stages = sectionsPresent(payload);
  const total = stages.length;
  let done = 0;

  const emit = (currentSection: string) => {
    if (typeof onProgress === "function") {
      onProgress({
        done,
        total,
        percent: total === 0 ? 100 : Math.round((done / total) * 100),
        currentSection,
      });
    }
  };

  const yieldToEventLoop = () =>
    new Promise<void>((resolve) => {
      if (typeof setImmediate === "function") setImmediate(resolve);
      else setTimeout(resolve, 0);
    });

  if (total === 0) {
    emit("done");
    return await exportDb();
  }
  emit(stages[0].name);

  // One transaction per section, not one for the whole restore: a large backup would
  // otherwise hold the write lock for its entire duration and block every request.
  for (const [index, section] of stages.entries()) {
    db.transaction(() => {
      section.restore(db, payload, context);
    });
    done += 1;
    emit(index + 1 < stages.length ? stages[index + 1].name : "done");
    await yieldToEventLoop();
  }

  // Same reasoning as importDb: the caches memo rows this call just rewrote.
  invalidateSettingsCache();
  invalidatePricingCache();
  invalidateApiKeyCache();
  invalidateNodeCache();

  return await exportDb();
}

// Eager init helper (optional)
export async function initDb() {
  await getAdapter();
}