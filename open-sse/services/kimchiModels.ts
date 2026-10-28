import { createHash } from "crypto";

import { proxyAwareFetch } from "../utils/proxyFetch.ts";
import type { Credentials, EngineLogger, ProxyOptions } from "../types.ts";

export const KIMCHI_API = "https://llm.kimchi.dev";
export const KIMCHI_USER_AGENT = "kimchi/0.1.40";

const FETCH_TIMEOUT_MS = 20_000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/** Canonical Kimchi model row (upstream raw fields are preserved). */
export interface KimchiModel {
  id: string;
  name: string;
  provider: string;
  upstreamProvider: string;
  reasoning: boolean;
  inputModalities: string[];
  kind: string;
  type: string;
  capabilities: Record<string, unknown>;
  contextLength?: number;
  maxOutputTokens?: number;
  compat?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Raw catalog row from `GET /v1/models/metadata`. */
interface KimchiRawModel {
  slug?: string;
  id?: string;
  model?: string;
  name?: string;
  display_name?: string;
  displayName?: string;
  input_modalities?: unknown[];
  limits?: { context_window?: number; max_output_tokens?: number };
  contextLength?: number;
  context_length?: number;
  maxOutputTokens?: number;
  max_output_tokens?: number;
  provider?: string;
  reasoning?: boolean;
  [key: string]: unknown;
}

/** Bypass/observe options for the live catalog fetch. */
export interface ResolveKimchiModelsOptions {
  forceRefresh?: boolean;
  log?: EngineLogger;
  signal?: AbortSignal;
  proxyOptions?: ProxyOptions | null;
  /** Base endpoint override (credential `kimchiEndpoint` wins). */
  endpoint?: string;
}

interface KimchiFetchError extends Error {
  status?: number;
  retryable?: boolean;
}

const catalogCache = new Map<string, {
  expiresAt: number;
  models: KimchiModel[];
  rawModels: KimchiRawModel[];
}>();
const metadataByModelId = new Map<string, KimchiModel>();

function normalizeKimchiEndpoint(endpoint: unknown) {
  const raw = typeof endpoint === "string" ? endpoint.trim() : "";
  return (raw || KIMCHI_API).replace(/\/+$/, "");
}

export function buildKimchiModelsUrl(endpoint: unknown) {
  return `${normalizeKimchiEndpoint(endpoint)}/v1/models/metadata?include_in_cli=true`;
}

function readToken(credentials: Credentials): string | null {
  return (
    credentials?.accessToken
    || credentials?.apiKey
    || (credentials?.providerSpecificData?.apiKey as string | undefined)
    || null
  );
}

function cacheKey(credentials: Credentials, endpoint: unknown) {
  const psd = credentials?.providerSpecificData || {};
  const seed = psd.userId || psd.username || credentials?.refreshToken || readToken(credentials) || "anonymous";
  return createHash("sha256")
    .update(`kimchi:${normalizeKimchiEndpoint(endpoint)}:${seed}`)
    .digest("hex");
}

function toModelKind(inputModalities: unknown) {
  return Array.isArray(inputModalities) && inputModalities.includes("image")
    ? "imageToText"
    : "llm";
}

export function normalizeKimchiModel(item: KimchiRawModel | null | undefined): KimchiModel | null {
  if (!item || typeof item !== "object") return null;
  const id = item.slug || item.id || item.model || item.name;
  if (typeof id !== "string" || id.trim() === "") return null;

  const inputModalities = Array.isArray(item.input_modalities)
    ? item.input_modalities.filter((value) => value === "text" || value === "image")
    : [];
  const limits = item.limits && typeof item.limits === "object" ? item.limits : {};
  const contextLength = Number(limits.context_window || item.contextLength || item.context_length) || undefined;
  const maxOutputTokens = Number(limits.max_output_tokens || item.maxOutputTokens || item.max_output_tokens) || undefined;
  const upstreamProvider = typeof item.provider === "string" ? item.provider : "";
  const reasoning = item.reasoning === true;
  const kind = toModelKind(inputModalities);

  const model: KimchiModel = {
    ...item,
    id: id.trim(),
    name: String(item.display_name || item.displayName || item.name || id).trim(),
    provider: upstreamProvider,
    upstreamProvider,
    reasoning,
    inputModalities,
    kind,
    type: kind,
    capabilities: {
      vision: inputModalities.includes("image"),
      reasoning,
      ...(contextLength ? { contextWindow: contextLength } : {}),
      ...(maxOutputTokens ? { maxOutput: maxOutputTokens } : {}),
      ...(upstreamProvider ? { upstreamProvider } : {}),
    },
    ...(contextLength ? { contextLength } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
  };

  if (upstreamProvider === "anthropic") {
    model.compat = { supportsReasoningEffort: false, cacheControlFormat: "anthropic" };
  }

  return model;
}

function rememberModels(models: KimchiModel[] | null | undefined) {
  for (const model of models || []) {
    if (!model?.id) continue;
    metadataByModelId.set(model.id, model);
    metadataByModelId.set(model.id.toLowerCase(), model);
  }
}

export function getCachedKimchiModelMetadata(modelId: unknown) {
  if (typeof modelId !== "string" || modelId.trim() === "") return null;
  const raw = (modelId.includes("/") ? modelId.split("/").pop() : modelId) as string;
  return metadataByModelId.get(raw) || metadataByModelId.get(raw.toLowerCase()) || null;
}

async function fetchKimchiCatalogRaw(
  token: string,
  endpoint: unknown,
  options: ResolveKimchiModelsOptions = {}
): Promise<KimchiRawModel[]> {
  const url = buildKimchiModelsUrl(endpoint);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Kimchi models fetch timeout")), FETCH_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;

  try {
    const response = await proxyAwareFetch(url, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "Authorization": `Bearer ${token}`,
        "User-Agent": KIMCHI_USER_AGENT,
      },
      cache: "no-store",
      signal,
    }, options.proxyOptions || null);

    if (!response.ok) {
      const error: KimchiFetchError = new Error(`Kimchi models ${response.status}: ${response.statusText}`);
      error.status = response.status;
      error.retryable = RETRYABLE_STATUSES.has(response.status);
      throw error;
    }

    const data = await response.json();
    return Array.isArray(data?.models) ? data.models : [];
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolveKimchiModels(
  credentials: Credentials,
  options: ResolveKimchiModelsOptions = {}
) {
  const token = readToken(credentials);
  if (!token) return null;

  const endpoint = credentials?.providerSpecificData?.kimchiEndpoint || options.endpoint || KIMCHI_API;
  // endpoint is only ever consumed as a base URL (normalized to a string).
  const key = cacheKey(credentials, endpoint);
  const now = Date.now();
  if (!options.forceRefresh) {
    const cached = catalogCache.get(key);
    if (cached && cached.expiresAt > now) return cached;
  }

  let rawModels: KimchiRawModel[];
  try {
    rawModels = await fetchKimchiCatalogRaw(token, endpoint, options);
  } catch (error) {
    options.log?.warn?.("KIMCHI_MODELS", (error as Error).message);
    return null;
  }

  const models = rawModels
    .map(normalizeKimchiModel)
    .filter((model): model is KimchiModel => Boolean(model));
  if (models.length === 0) return null;

  rememberModels(models);
  const entry = {
    expiresAt: Date.now() + CACHE_TTL_MS,
    models,
    rawModels,
  };
  catalogCache.set(key, entry);
  return entry;
}

export function clearKimchiCatalog() {
  catalogCache.clear();
  metadataByModelId.clear();
}
