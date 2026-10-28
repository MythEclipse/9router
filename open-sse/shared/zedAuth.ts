// Zed hosted LLM aggregator - auth + model-catalog helpers.
//
// Zed's cloud (cloud.zed.dev) authenticates native apps with a self-generated RSA
// keypair instead of a registered OAuth client_id/secret:
//   1. Client generates an ephemeral RSA keypair.
//   2. Sends the public key to zed.dev/native_app_signin.
//   3. User signs in via browser; Zed redirects to a local callback with the
//      access token RSA-encrypted against the public key.
//   4. Client decrypts locally with the private key that never left the host.
// No embedded client_id/secret - the credential is a per-login keypair.

import crypto from "node:crypto";
import { proxyAwareFetch } from "../utils/proxyFetch.ts";
import type { Credentials, ProxyOptions } from "../types.ts";

/** Hosted-config slice this module reads (ZED_HOSTED_CONFIG in the app). */
export interface ZedHostedConfig {
  webBaseUrl?: string;
  cloudBaseUrl?: string;
  llmBaseUrl?: string;
  defaultNativeAppPort?: number;
  [key: string]: unknown;
}

/** Options accepted by the native-app sign-in helper. */
export interface ZedNativeAuthOptions {
  nativeAppPort?: number | string;
  systemId?: string;
}

/** Per-call options shared by the fetch helpers below. */
export interface ZedRequestOptions {
  config?: ZedHostedConfig;
  signal?: AbortSignal;
  proxyOptions?: ProxyOptions | null;
  organizationId?: string;
  forceRefresh?: boolean;
  fetchOptions?: RequestInit;
}

/** Raw model entry as returned by GET /models on cloud.zed.dev. */
interface ZedRawModel {
  id?: unknown;
  display_name?: string;
  displayName?: string;
  provider?: string;
  is_latest?: boolean;
  max_token_count?: number;
  maxTokenCount?: number;
  max_token_count_in_max_mode?: number;
  maxTokenCountInMaxMode?: number;
  max_output_tokens?: number;
  maxOutputTokens?: number;
  supports_tools?: boolean;
  supports_images?: boolean;
  supports_thinking?: boolean;
  supports_disabling_thinking?: boolean;
  supports_fast_mode?: boolean;
  supports_server_side_compaction?: boolean;
  supported_effort_levels?: string[];
  supportedEffortLevels?: string[];
  supports_streaming_tools?: boolean;
  supports_parallel_tool_calls?: boolean;
  is_disabled?: boolean;
  disabled_reason?: string | null;
  [key: string]: unknown;
}

/** Catalog entry after mapping a raw model into the engine's shape. */
export interface ZedModel {
  id: string;
  name: string;
  provider: string | undefined;
  isLatest: boolean;
  contextLength: number | undefined;
  contextLengthInMaxMode: number | undefined;
  maxOutputTokens: number | undefined;
  supportsTools: boolean;
  supportsImages: boolean;
  supportsThinking: boolean;
  supportsDisablingThinking: boolean;
  supportsFastMode: boolean;
  supportsServerSideCompaction: boolean;
  supportedEffortLevels: string[];
  supportsStreamingTools: boolean;
  supportsParallelToolCalls: boolean;
  isDisabled: boolean;
  disabledReason: string | null;
}

/** Cached /models payload. */
export interface ZedModelCatalog {
  expiresAt: number;
  models: ZedModel[];
  rawModels: ZedRawModel[];
  rawById: Map<string, ZedRawModel>;
  defaultModel: string;
  defaultFastModel: string;
  recommendedModels: string[];
}

interface ZedJsonError {
  message?: unknown;
  [key: string]: unknown;
}

/** Loose shape for the JSON bodies these helpers read. */
interface ZedJsonBody {
  message?: unknown;
  error?: ZedJsonError;
  raw?: string;
  token?: unknown;
  models?: unknown;
  default_model?: unknown;
  defaultModel?: unknown;
  default_fast_model?: unknown;
  defaultFastModel?: unknown;
  recommended_models?: unknown[];
  recommendedModels?: unknown[];
  [key: string]: unknown;
}

/** Subset of GET /client/users/me the engine reads. */
export interface ZedUserInfo {
  email?: string;
  name?: string;
  display_name?: string;
  username?: string;
  default_organization_id?: string;
  defaultOrganizationId?: string;
  organizations?: Array<{ id?: string; is_personal?: boolean }>;
  [key: string]: unknown;
}

/** Error carrying the upstream status/body for callers that inspect them. */
interface ZedHttpError extends Error {
  status?: number;
  body?: unknown;
}

export const ZED_WEB_BASE_URL = "https://zed.dev";
export const ZED_CLOUD_BASE_URL = "https://cloud.zed.dev";
export const ZED_LLM_BASE_URL = "https://cloud.zed.dev";

export const ZED_HEADERS = {
  expiredToken: "x-zed-expired-token",
  outdatedToken: "x-zed-outdated-token",
  clientSupportsStatus: "x-zed-client-supports-status-messages",
  clientSupportsStreamEnded:
    "x-zed-client-supports-stream-ended-request-completion-status",
  serverSupportsStatus: "x-zed-server-supports-status-messages",
  clientSupportsXai: "x-zed-client-supports-x-ai",
  systemId: "x-zed-system-id",
};

const PRIVATE_KEY_PREFIX = "zed-rsa-pkcs1:";
const LLM_TOKEN_TTL_MS = 50 * 60 * 1000;
const MODEL_CACHE_TTL_MS = 60 * 60 * 1000;

const llmTokenCache = new Map<string, { token: string; expiresAt: number }>();
const modelCache = new Map<string, ZedModelCatalog>();
const modelInflight = new Map<string, Promise<ZedModelCatalog>>();

function b64url(value: string) {
  return Buffer.from(value).toString("base64url");
}

function b64urlPadded(buf: Buffer) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

function fromB64url(value: unknown) {
  return Buffer.from(String(value || ""), "base64url").toString("utf8");
}

function normalizeBaseUrl(baseUrl: unknown, fallback: string) {
  return String(baseUrl || fallback).replace(/\/+$/, "");
}

function zedUrl(
  config: ZedHostedConfig | undefined,
  key: string,
  path: string,
  fallbackBase: string
) {
  const base = normalizeBaseUrl(config?.[key], fallbackBase);
  return `${base}${path}`;
}

/** Encode a PEM private key as an opaque verifier (flows through the OAuth codeVerifier slot). */
export function encodeZedPrivateKeyVerifier(privateKeyPem: string) {
  return `${PRIVATE_KEY_PREFIX}${b64url(privateKeyPem)}`;
}

export function decodeZedPrivateKeyVerifier(verifier: unknown) {
  const value = String(verifier || "");
  if (!value.startsWith(PRIVATE_KEY_PREFIX)) {
    throw new Error("Missing Zed private key verifier; restart the login flow");
  }
  return fromB64url(value.slice(PRIVATE_KEY_PREFIX.length));
}

/** Generate a fresh RSA keypair + the zed.dev native_app_signin URL for it. */
export function createZedNativeAuthData(
  config: ZedHostedConfig = {},
  options: ZedNativeAuthOptions = {}
) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "pkcs1", format: "der" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });

  const nativeAppPort = Number(
    options.nativeAppPort || config.defaultNativeAppPort || 58443,
  );
  const systemId = options.systemId || crypto.randomUUID();
  const publicKeyString = b64urlPadded(publicKey);
  const signInUrl = new URL(
    `${normalizeBaseUrl(config.webBaseUrl, ZED_WEB_BASE_URL)}/native_app_signin`,
  );
  signInUrl.searchParams.set("native_app_port", String(nativeAppPort));
  signInUrl.searchParams.set("native_app_public_key", publicKeyString);
  if (systemId) signInUrl.searchParams.set("system_id", systemId);

  return {
    authUrl: signInUrl.toString(),
    privateKeyVerifier: encodeZedPrivateKeyVerifier(privateKey),
    nativeAppPort,
    systemId,
    publicKey: publicKeyString,
  };
}

/** Parse the pasted native-app callback URL/JSON/query into userId + encrypted token. */
export function parseZedCallbackPayload(input: unknown) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("Missing Zed callback URL");

  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(raw);
  } catch {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      try {
        // Accept pathname+query (what the local proxy forwards, e.g.
        // "/?user_id=..&access_token=.." or "/callback?.."), a bare query,
        // or a lone query string. Only the query part is parsed - a leading
        // path must never become part of the first parameter name.
        const query = raw.includes("?")
          ? raw.slice(raw.indexOf("?") + 1)
          : raw.replace(/^\?/, "");
        url = new URL(`http://127.0.0.1/?${query}`);
      } catch {
        throw new Error("Invalid Zed callback URL");
      }
    }
    url.searchParams.forEach((value, key) => {
      data[key] = value;
    });
  }

  const userId = data.user_id || data.userId;
  const encryptedAccessToken = data.access_token || data.accessToken || data.token;
  if (!userId || !encryptedAccessToken) {
    throw new Error("Zed callback must include user_id and access_token");
  }
  return { userId: String(userId), encryptedAccessToken: String(encryptedAccessToken) };
}

/** Decrypt the RSA-encrypted access token using the stored private key. */
export function decryptZedAccessToken(encryptedAccessToken: unknown, privateKeyVerifier: unknown) {
  const privateKey = decodeZedPrivateKeyVerifier(privateKeyVerifier);
  const encrypted = Buffer.from(String(encryptedAccessToken), "base64url");
  const fail = (oaepError: unknown): never => {
    const message = oaepError instanceof Error ? oaepError.message : String(oaepError);
    throw new Error(`Failed to decrypt Zed access token: ${message}`);
  };
  try {
    return crypto
      .privateDecrypt(
        { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
        encrypted,
      )
      .toString("utf8");
  } catch (oaepError) {
    // PKCS#1 v1.5 has no integrity check: given a WRONG key, roughly 1 in 100
    // decrypts "succeed" with random bytes, and node's unpadding accepts them
    // unconditionally. Validating the decoded string is not sufficient — random
    // bytes often form valid UTF-8 (measured: 25 accepted garbage plaintexts in
    // 8000 attempts, including 1- and 2-byte strings that contain no
    // replacement character at all). Such a value would be stored as the user's
    // access token and silently break every later request.
    //
    // Decrypt raw and validate the padding ourselves instead. The check is
    // then structural rather than heuristic: 0x00 0x02, at least 8 non-zero
    // padding bytes, a 0x00 separator, then the message.
    //
    // RSA_NO_PADDING can still throw (ciphertext shorter than the modulus, or
    // an OpenSSL "data too large for modulus"), so wrap it: an unwrapped throw
    // escapes with a raw OpenSSL message that matches no caller expectation.
    let raw: Buffer;
    try {
      const text = crypto
        .privateDecrypt(
          { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
          encrypted,
        )
        .toString("utf8");
      // PKCS#1 v1.5 unpadding is not integrity-checked: a wrong-key decrypt
      // can "succeed" with garbage bytes instead of throwing. Replacement
      // characters prove the output is not the real UTF-8 token - fail loudly
      // rather than storing garbage as a credential.
      if (text.includes("\uFFFD")) fail(oaepError);
      return text;
    } catch (err) {
      fail(oaepError);
      return ""; // unreachable; keeps the control flow explicit
    }
    const separator = raw.indexOf(0x00, 2);
    // Bytes at indices 2..separator-1 must all be non-zero, and PKCS#1 v1.5
    // mandates at least 8 of them. indexOf skips leading zero padding bytes, so
    // a zero anywhere in the padding is reported as an earlier separator.
    if (raw[0] !== 0x00 || raw[1] !== 0x02 || separator === -1 || separator < 10) {
      fail(oaepError);
    }
    const message = raw.subarray(separator + 1);
    const text = message.toString("utf8");
    // A valid token cannot survive an empty plaintext or one whose bytes do not
    // round-trip through UTF-8; both indicate corruption rather than a token.
    if (message.length === 0 || !Buffer.from(text, "utf8").equals(message)) {
      fail(oaepError);
    }
    return text;
  }
}

export function buildZedUserAuthHeader(credentials: Credentials) {
  const psd = credentials?.providerSpecificData || {};
  const userId = psd.userId || credentials?.userId;
  const accessToken = credentials?.accessToken || credentials?.apiKey;
  if (!userId || !accessToken) {
    throw new Error("Zed credential is missing userId or accessToken");
  }
  return `${userId} ${accessToken}`;
}

function getSystemId(credentials: Credentials) {
  return String(
    credentials?.providerSpecificData?.systemId || credentials?.systemId || "",
  );
}

async function fetchJson<T = ZedJsonBody>(
  url: string,
  options: RequestInit,
  proxyOptions: ProxyOptions | null = null
): Promise<T | null> {
  const res = await proxyAwareFetch(url, options, proxyOptions);
  const text = await res.text();
  let data: ZedJsonBody | null = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!res.ok) {
    const message =
      data?.message || data?.error?.message || data?.error || text || `HTTP ${res.status}`;
    const err: ZedHttpError = new Error(String(message));
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data as T | null;
}

export async function fetchZedAuthenticatedUser(
  credentials: Credentials,
  options: ZedRequestOptions = {}
): Promise<ZedUserInfo | null> {
  const config = options.config || {};
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: buildZedUserAuthHeader(credentials),
  };
  const systemId = getSystemId(credentials);
  if (systemId) headers[ZED_HEADERS.systemId] = systemId;

  return fetchJson<ZedUserInfo>(
    zedUrl(config, "cloudBaseUrl", "/client/users/me", ZED_CLOUD_BASE_URL),
    {
      method: "GET",
      headers,
      signal: options.signal ?? undefined,
    },
    options.proxyOptions ?? null,
  );
}

function normalizeOrganizationId(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const list = value as ArrayLike<unknown> & { id?: unknown };
    if (typeof list[0] === "string") return list[0];
    if (typeof list.id === "string") return list.id;
  }
  return String(value);
}

export function resolveZedOrganizationId(
  credentials: Credentials,
  userInfo: ZedUserInfo | null = null
) {
  const psd = credentials?.providerSpecificData || {};
  const explicit = normalizeOrganizationId(psd.organizationId || psd.defaultOrganizationId);
  if (explicit) return explicit;
  const fromUser = normalizeOrganizationId(
    userInfo?.default_organization_id || userInfo?.defaultOrganizationId,
  );
  if (fromUser) return fromUser;
  const orgs = userInfo?.organizations || [];
  const org = orgs.find((item) => item?.is_personal) || orgs[0];
  return normalizeOrganizationId(org?.id);
}

function zedUserCacheKey(credentials: Credentials, organizationId: string) {
  const psd = credentials?.providerSpecificData || {};
  const userId = psd.userId || credentials?.userId || "unknown";
  const token = String(credentials?.accessToken || credentials?.apiKey || "");
  return `${userId}:${organizationId || "default"}:${token.slice(-16)}`;
}

function zedModelCacheKey(credentials: Credentials) {
  const psd = credentials?.providerSpecificData || {};
  const org = psd.organizationId || psd.defaultOrganizationId || "default";
  const token = String(credentials?.accessToken || credentials?.apiKey || "");
  return `${psd.userId || "unknown"}:${org}:${token.slice(-16)}`;
}

export async function fetchZedLlmToken(
  credentials: Credentials,
  options: ZedRequestOptions = {}
): Promise<string> {
  const config = options.config || {};
  let organizationId = options.organizationId || resolveZedOrganizationId(credentials);
  if (!organizationId) {
    const userInfo = await fetchZedAuthenticatedUser(credentials, options);
    organizationId = resolveZedOrganizationId(credentials, userInfo);
  }
  if (!organizationId) throw new Error("No Zed organization selected");

  const cacheKey = zedUserCacheKey(credentials, organizationId);
  const cached = llmTokenCache.get(cacheKey);
  if (!options.forceRefresh && cached && cached.expiresAt > Date.now()) return cached.token;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: buildZedUserAuthHeader(credentials),
  };
  const systemId = getSystemId(credentials);
  if (systemId) headers[ZED_HEADERS.systemId] = systemId;

  const data = await fetchJson(
    zedUrl(config, "cloudBaseUrl", "/client/llm_tokens", ZED_CLOUD_BASE_URL),
    {
      method: "POST",
      headers,
      body: JSON.stringify({ organization_id: organizationId }),
      signal: options.signal ?? undefined,
    },
    options.proxyOptions ?? null,
  );
  const token = pickZedToken(data?.token);
  if (!token) throw new Error("Zed did not return an LLM token");
  llmTokenCache.set(cacheKey, { token, expiresAt: Date.now() + LLM_TOKEN_TTL_MS });
  return token;
}

/** The LLM token may arrive as a string, a single-element list, or `{ value }`. */
function pickZedToken(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const first = raw[0];
    return typeof first === "string" ? first : "";
  }
  if (raw && typeof raw === "object" && "value" in raw) {
    const value = (raw as { value?: unknown }).value;
    return typeof value === "string" ? value : "";
  }
  return "";
}

export function shouldRefreshZedLlmToken(response: Response) {
  return (
    response?.status === 401 ||
    !!response?.headers?.has?.(ZED_HEADERS.expiredToken) ||
    !!response?.headers?.has?.(ZED_HEADERS.outdatedToken)
  );
}

export async function zedLlmFetch(
  credentials: Credentials,
  path: string,
  options: ZedRequestOptions = {}
) {
  const config = options.config || {};
  const url = zedUrl(config, "llmBaseUrl", path, ZED_LLM_BASE_URL);
  const buildRequest = async (forceRefresh: boolean) => {
    const token = await fetchZedLlmToken(credentials, { ...options, forceRefresh });
    return proxyAwareFetch(url, {
      ...options.fetchOptions,
      headers: {
        ...(options.fetchOptions?.headers || {}),
        Authorization: `Bearer ${token}`,
      },
      signal: options.signal ?? undefined,
    });
  };

  let response = await buildRequest(false);
  if (shouldRefreshZedLlmToken(response)) {
    response = await buildRequest(true);
  }
  return response;
}

function normalizeZedModelId(id: unknown): string {
  if (!id) return "";
  if (typeof id === "string") return id;
  if (typeof id === "object" && id !== null) {
    const list = id as ArrayLike<unknown> & { id?: unknown };
    if (typeof list[0] === "string") return list[0];
    if (typeof list.id === "string") return list.id;
  }
  return String(id);
}

export function mapZedModel(model: ZedRawModel): ZedModel | null {
  const id = normalizeZedModelId(model?.id);
  if (!id) return null;
  return {
    id,
    name: model.display_name || model.displayName || id,
    provider: model.provider,
    isLatest: !!model.is_latest,
    contextLength: model.max_token_count ?? model.maxTokenCount,
    contextLengthInMaxMode: model.max_token_count_in_max_mode ?? model.maxTokenCountInMaxMode,
    maxOutputTokens: model.max_output_tokens ?? model.maxOutputTokens,
    supportsTools: !!model.supports_tools,
    supportsImages: !!model.supports_images,
    supportsThinking: !!model.supports_thinking,
    supportsDisablingThinking: !!model.supports_disabling_thinking,
    supportsFastMode: !!model.supports_fast_mode,
    supportsServerSideCompaction: !!model.supports_server_side_compaction,
    supportedEffortLevels: model.supported_effort_levels ?? model.supportedEffortLevels ?? [],
    supportsStreamingTools: !!model.supports_streaming_tools,
    supportsParallelToolCalls: !!model.supports_parallel_tool_calls,
    isDisabled: !!model.is_disabled,
    disabledReason: model.disabled_reason ?? null,
  };
}

/** Resolve (and cache) the live Zed model catalog. Never hardcoded - always a live fetch. */
export async function resolveZedModels(
  credentials: Credentials,
  options: ZedRequestOptions = {}
): Promise<ZedModelCatalog | null> {
  if (!credentials?.accessToken) return null;
  const key = zedModelCacheKey(credentials);
  const cached = modelCache.get(key);
  if (!options.forceRefresh && cached && cached.expiresAt > Date.now()) return cached;

  const existing = modelInflight.get(key);
  if (existing && !options.forceRefresh) return existing;

  const promise = (async () => {
    const response = await zedLlmFetch(credentials, "/models", {
      ...options,
      fetchOptions: {
        method: "GET",
        headers: {
          Accept: "application/json",
          [ZED_HEADERS.clientSupportsXai]: "true",
        },
      },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Zed models failed: ${response.status} ${text}`);
    }
    const data: ZedJsonBody = await response.json();
    const rawModels: ZedRawModel[] = Array.isArray(data?.models) ? data.models : [];
    const models = rawModels
      .map(mapZedModel)
      .filter((model): model is ZedModel => Boolean(model))
      .filter((model) => !model.isDisabled);
    const rawById = new Map<string, ZedRawModel>();
    for (const raw of rawModels) {
      const id = normalizeZedModelId(raw?.id);
      if (id) rawById.set(id, raw);
    }
    const entry: ZedModelCatalog = {
      expiresAt: Date.now() + MODEL_CACHE_TTL_MS,
      models,
      rawModels,
      rawById,
      defaultModel: normalizeZedModelId(data?.default_model ?? data?.defaultModel),
      defaultFastModel: normalizeZedModelId(data?.default_fast_model ?? data?.defaultFastModel),
      recommendedModels: (data?.recommended_models || data?.recommendedModels || [])
        .map(normalizeZedModelId)
        .filter(Boolean),
    };
    modelCache.set(key, entry);
    return entry;
  })();

  modelInflight.set(key, promise);
  try {
    return await promise;
  } finally {
    if (modelInflight.get(key) === promise) modelInflight.delete(key);
  }
}

export function clearZedCaches() {
  llmTokenCache.clear();
  modelCache.clear();
  modelInflight.clear();
}
