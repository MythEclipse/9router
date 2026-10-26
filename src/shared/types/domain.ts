/**
 * Shared dashboard/API domain types.
 *
 * One canonical shape per entity the dashboard and the API routes both handle.
 * The JS→TS migration left every route and page inferring these from untyped
 * repo calls, which is why property access on them failed wholesale. Declaring
 * them here (rather than per route) means a page and the route it calls can
 * never drift, and a new field only has to be added once.
 *
 * These describe the *API* view of a record (camelCase, flattened), not the
 * SQLite columns - repos convert at the boundary.
 */

/** A provider connection (account) as returned by the connections repo. */
export interface Connection {
  id: string;
  provider: string;
  authType?: string;
  name?: string | null;
  email?: string | null;
  displayName?: string | null;
  priority?: number;
  isActive?: boolean | number;
  accessToken?: string;
  refreshToken?: string;
  apiKey?: string;
  idToken?: string;
  expiresAt?: number | string | null;
  expiresIn?: number | null;
  lastRefreshAt?: number | null;
  projectId?: string | null;
  providerSpecificData?: Record<string, unknown> | null;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

/** A provider node (custom OpenAI/Anthropic-compatible endpoint). */
export interface ProviderNode {
  id: string;
  type?: string;
  name?: string;
  prefix?: string;
  apiType?: string;
  baseUrl?: string;
  data?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

/** A proxy pool entry used by no-auth providers. */
export interface ProxyPool {
  id: string;
  name?: string;
  proxyUrl?: string;
  isActive?: boolean | number;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

/** An API key issued by the dashboard. */
export interface ApiKey {
  id: string;
  key?: string;
  name?: string;
  isActive?: boolean | number;
  access?: Record<string, unknown> | null;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

/** A model combo (ordered fallback list). */
export interface Combo {
  id: string;
  name: string;
  models?: string[];
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

/** One model as surfaced to the dashboard / `/v1/models`. */
export interface ModelInfo {
  id: string;
  name?: string;
  owned_by?: string;
  provider?: string;
  alias?: string;
  isCustom?: boolean;
  capabilities?: Record<string, boolean>;
  pluginMarks?: string[];
  contextWindow?: number;
  [key: string]: unknown;
}

/** A quota row rendered by the ProviderLimits cards. */
export interface QuotaEntry {
  name?: string;
  displayName?: string;
  used?: number;
  total?: number;
  remaining?: number;
  resetAt?: string | number | null;
  remainingPercentage?: number;
  unit?: string;
  [key: string]: unknown;
}

/** A connection's quota payload (`quotaCacheData[connectionId]`). */
export interface ConnectionQuotaData {
  quotas?: QuotaEntry[];
  updatedAt?: number;
  [key: string]: unknown;
}

/** Quota cache keyed by connection id. */
export type QuotaCache = Record<string, ConnectionQuotaData | undefined>;

/** Aggregated usage counters for one provider/model/endpoint group. */
export interface UsageCounters {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cost: number;
  rawModel?: string;
  provider?: string;
  resolvedModel?: string;
  endpoint?: string;
  lastUsed?: string;
  [key: string]: unknown;
}

/** One row of the request-log table. */
export interface UsageHistoryRow {
  id?: number | string;
  timestamp: string;
  provider?: string;
  model?: string;
  connectionId?: string;
  apiKeyMasked?: string;
  endpoint?: string;
  cost?: number;
  status?: string;
  tokens?: Record<string, number>;
  resolvedModel?: string | null;
  [key: string]: unknown;
}

/** A dashboard notification record from the notifications repo. */
export interface AppNotification {
  id: string;
  type?: string;
  title?: string;
  message?: string;
  read?: boolean | number;
  createdAt?: string;
  [key: string]: unknown;
}

/** A CLI tool status row (cli-tools pages and their APIs). */
export interface CliToolStatus {
  toolId?: string;
  configured?: boolean;
  status?: string;
  [key: string]: unknown;
}

/** A saved settings history revision. */
export interface SettingsRevision {
  id: string | number;
  createdAt?: string;
  label?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

/** A pricing entry from the pricing repo. */
export interface ModelPricing {
  model: string;
  provider?: string;
  input?: number;
  output?: number;
  cached?: number;
  [key: string]: unknown;
}
