/**
 * Cursor live model catalog fetcher.
 *
 * Cursor exposes the account-specific model picker through the AgentService
 * `GetUsableModels` Connect RPC. Unlike the static provider registry, this
 * includes models newly enabled for the account and omits unavailable ones.
 */

import crypto from "crypto";
import http2 from "http2";
import { PROVIDER_OAUTH } from "../providers/index.ts";
import { buildCursorHeaders } from "../utils/cursorChecksum.ts";
import { decodeMessage } from "../utils/cursorProtobuf.ts";
import type { Credentials, EngineLogger } from "../types.ts";

const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 5 * 60 * 1000;

// agent.v1.ModelDetails protobuf field numbers.
const MODEL_ID_FIELD = 1;
const DISPLAY_MODEL_ID_FIELD = 3;
const DISPLAY_NAME_FIELD = 4;
const DISPLAY_NAME_SHORT_FIELD = 5;
const RESPONSE_MODELS_FIELD = 1;

// agent.v1.AvailableModels (response field 2) carries the model-picker flags
// AgentService honours: agent support, chat-only, hidden, and the account's
// default-on pick used to resolve the "Auto (Server Picks)" entry.
const RESPONSE_AVAILABLE_MODELS_FIELD = 2;
const AVAILABLE_MODEL_NAME_FIELD = 1;
const AVAILABLE_MODEL_DEFAULT_ON_FIELD = 2;
const AVAILABLE_MODEL_IS_CHAT_ONLY_FIELD = 4;
const AVAILABLE_MODEL_SUPPORTS_AGENT_FIELD = 5;
const AVAILABLE_MODEL_IS_HIDDEN_FIELD = 35;

/** A model row from the usable-models RPC, before picker flags are merged. */
export interface CursorModelEntry {
  id: string;
  name: string;
}

/** Picker flags carried by the response's AvailableModels field. */
export interface CursorModelFlags {
  id: string;
  defaultOn: boolean;
  isChatOnly: boolean;
  supportsAgent: boolean;
  isHidden: boolean;
}

/** A usable model with its picker flags merged in (when the server sent them). */
export type CursorModel = CursorModelEntry & Partial<Omit<CursorModelFlags, "id">>;

/** Bypass/observe options for the live catalog fetch. */
export interface ResolveCursorModelsOptions {
  forceRefresh?: boolean;
  log?: EngineLogger;
  signal?: AbortSignal;
}

interface CursorFetchError extends Error {
  status?: number;
}

/** Wire result of the HTTP/2 unary call. */
interface CursorProtoResponse {
  status: number;
  body: Buffer;
}

const catalogCache = new Map<string, { expiresAt: number; models: CursorModel[] }>();

function getCursorModelsUrl() {
  const config = PROVIDER_OAUTH.cursor;
  if (!config?.agentEndpoint || !config?.modelsEndpoint) return null;
  return `${config.agentEndpoint.replace(/\/$/, "")}${config.modelsEndpoint}`;
}

function cacheKey(credentials: Credentials) {
  const seed = [
    credentials?.providerSpecificData?.machineId,
    credentials?.accessToken,
  ].filter(Boolean).join(":");
  if (!seed) return "cursor-anonymous";
  return crypto.createHash("sha256").update(`cursor:${seed}`).digest("hex");
}

function firstString(fields: ReturnType<typeof decodeMessage>, fieldNumber: number) {
  const value = fields.get(fieldNumber)?.[0]?.value;
  if (!value || typeof value === "number") return "";
  return Buffer.from(value).toString("utf8");
}

function firstBool(fields: ReturnType<typeof decodeMessage>, fieldNumber: number) {
  const value = fields.get(fieldNumber)?.[0]?.value;
  return value === 1;
}

/**
 * Decode Cursor's `agent.v1.GetUsableModelsResponse` protobuf payload.
 * The response contains repeated `agent.v1.ModelDetails` messages in field 1.
 */
export function parseCursorUsableModels(payload: Uint8Array): CursorModelEntry[] {
  const response = decodeMessage(payload);
  const seen = new Set<string>();
  const models: CursorModelEntry[] = [];

  for (const entry of response.get(RESPONSE_MODELS_FIELD) || []) {
    if (!entry?.value || typeof entry.value === "number") continue;
    const detail = decodeMessage(entry.value);
    const id = firstString(detail, MODEL_ID_FIELD).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const name = (
      firstString(detail, DISPLAY_NAME_FIELD)
      || firstString(detail, DISPLAY_NAME_SHORT_FIELD)
      || firstString(detail, DISPLAY_MODEL_ID_FIELD)
      || id
    ).trim();
    models.push({ id, name });
  }

  return models;
}

/**
 * agent.api5.cursor.sh is HTTP/2-only; Node fetch/undici cannot speak h2.
 * Unary GetUsableModels uses an unframed protobuf body (application/proto).
 */
function http2PostProto(
  url: string,
  headers: Record<string, string | number>,
  body: Uint8Array,
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<CursorProtoResponse> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const client = http2.connect(`https://${urlObj.host}`);
    const chunks: Buffer[] = [];
    let responseHeaders: http2.IncomingHttpHeaders = {};
    let settled = false;

    const finish = (fn: (...args: unknown[]) => void) => (...args: unknown[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      try { client.close(); } catch {}
      fn(...args);
    };

    const timeoutId = setTimeout(finish(() => {
      reject(new Error("Cursor GetUsableModels timed out"));
    }), timeoutMs);

    client.on("error", finish(reject));

    const req = client.request({
      ":method": "POST",
      ":path": urlObj.pathname,
      ":authority": urlObj.host,
      ":scheme": "https",
      ...headers,
    });

    req.on("response", (hdrs) => { responseHeaders = hdrs; });
    req.on("data", (chunk) => { chunks.push(chunk); });
    req.on("end", finish(() => {
      resolve({
        status: Number(responseHeaders[":status"] || 0),
        body: Buffer.concat(chunks),
      });
    }));
    req.on("error", finish(reject));

    if (signal) {
      const onAbort = finish(() => reject(new Error("Request aborted")));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    req.end(body && body.length ? Buffer.from(body) : undefined);
  });
}

async function fetchCursorCatalog(credentials: Credentials, signal?: AbortSignal) {
  const accessToken = credentials?.accessToken;
  const machineId = credentials?.providerSpecificData?.machineId;
  const url = getCursorModelsUrl();
  if (!accessToken || !machineId || !url) return null;

  const headers: Record<string, string | number> = {
    ...buildCursorHeaders(accessToken, String(machineId), credentials?.providerSpecificData?.ghostMode !== false),
    // Connect unary calls use an unframed protobuf body, unlike Cursor chat's
    // streaming `application/connect+proto` endpoint.
    accept: "application/proto",
    "content-type": "application/proto",
  };
  delete headers["connect-accept-encoding"];
  delete headers["connect-protocol-version"];

  const response = await http2PostProto(url, headers, new Uint8Array(), signal, FETCH_TIMEOUT_MS);
  if (response.status !== 200) {
    const error: CursorFetchError = new Error(`Cursor GetUsableModels returned ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return mergeCursorModelFlags(parseCursorUsableModels(new Uint8Array(response.body)), response.body);
}

/**
 * Attach model-picker flags (supportsAgent/defaultOn/…) from the response's
 * AvailableModels onto the usable-models list so callers can resolve the
 * auto/default entry. Only mutates when the server sent field 2, keeping the
 * parsed shape backward compatible.
 */
export function mergeCursorModelFlags(
  models: CursorModel[],
  payload: Uint8Array
): CursorModel[] {
  const available = parseCursorAvailableModels(payload);
  if (!available.length || !Array.isArray(models)) return models;
  const flagsById = new Map(available.map((model) => [model.id, model]));
  return models.map((model) => {
    const flags = flagsById.get(model.id);
    return flags ? { ...model, ...flags } : model;
  });
}

/**
 * Decode the current Cursor model-picker catalog (response field 2,
 * agent.v1.AvailableModels): the canonical AgentService model name plus the
 * picker flags needed to resolve "Auto (Server Picks)" to a real model.
 */
export function parseCursorAvailableModels(payload: Uint8Array): CursorModelFlags[] {
  const response = decodeMessage(payload);
  const seen = new Set<string>();
  const models: CursorModelFlags[] = [];

  for (const entry of response.get(RESPONSE_AVAILABLE_MODELS_FIELD) || []) {
    if (!entry?.value || typeof entry.value === "number") continue;
    const fields = decodeMessage(entry.value);
    const id = firstString(fields, AVAILABLE_MODEL_NAME_FIELD).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);

    models.push({
      id,
      defaultOn: firstBool(fields, AVAILABLE_MODEL_DEFAULT_ON_FIELD),
      isChatOnly: firstBool(fields, AVAILABLE_MODEL_IS_CHAT_ONLY_FIELD),
      supportsAgent: firstBool(fields, AVAILABLE_MODEL_SUPPORTS_AGENT_FIELD),
      isHidden: firstBool(fields, AVAILABLE_MODEL_IS_HIDDEN_FIELD),
    });
  }

  return models;
}

/**
 * "Auto (Server Picks)" / "default" is not a real AgentService model id —
 * sending it verbatim makes Run come back empty. Resolve it to the account's
 * default agent-capable model so the server picks like the IDE does. Prefers
 * the picker's defaultOn model, then the first usable agent model.
 */
export function resolveAutoModelSelection(models: CursorModel[]) {
  if (!Array.isArray(models) || models.length === 0) return null;
  const usable = models.filter((model) => model.supportsAgent && !model.isChatOnly && !model.isHidden);
  if (usable.length === 0) return null;
  const preferred = usable.find((model) => model.defaultOn) || usable[0];
  return {
    modelId: preferred.id,
    matchedBy: "auto-default",
  };
}

/**
 * Resolve the live Cursor catalog for the authenticated account.
 * Returns null on any failure so callers can fall back to static models.
 */
export async function resolveCursorModels(
  credentials: Credentials,
  options: ResolveCursorModelsOptions = {}
): Promise<{ models: CursorModel[] } | null> {
  if (!credentials?.accessToken || !credentials?.providerSpecificData?.machineId) {
    options.log?.debug?.("CURSOR_MODELS", "No Cursor access token or machine ID; skipping live fetch");
    return null;
  }

  const key = cacheKey(credentials);
  const now = Date.now();
  if (!options.forceRefresh) {
    const cached = catalogCache.get(key);
    if (cached?.expiresAt > now) return { models: cached.models };
  }

  try {
    const models = await fetchCursorCatalog(credentials, options.signal);
    if (!models?.length) return null;
    catalogCache.set(key, { expiresAt: now + CACHE_TTL_MS, models });
    return { models };
  } catch (error) {
    options.log?.warn?.("CURSOR_MODELS", `Live model fetch failed: ${(error as Error)?.message || error}`);
    return null;
  }
}

export function clearCursorModelCache() {
  catalogCache.clear();
}
