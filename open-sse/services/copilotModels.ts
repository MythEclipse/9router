/**
 * GitHub Copilot model catalog fetcher.
 *
 * Calls Copilot's `GET /models` endpoint to get the live catalog for an
 * authenticated account, so `/v1/models` reflects what the account can
 * actually use (e.g. newly shipped `claude-opus-4.8`, `gpt-5.5`) instead of
 * the hand-maintained static registry, which inevitably lags behind.
 *
 * Returns chat-capable models the account's policy allows. Embeddings and
 * disabled models are filtered out.
 */

import { proxyAwareFetch } from "../utils/proxyFetch";
import { GITHUB_COPILOT } from "../config/appConstants";
import { refreshCopilotToken } from "./tokenRefresh";
import type { Credentials, EngineLogger } from "../types";

const MODELS_URL = "https://api.githubcopilot.com/models";
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes per credential

export interface CopilotModelEntry {
  id: string;
  name: string;
}

/** Bypass/observe options for the live catalog fetch. */
export interface ResolveCopilotModelsOptions {
  /** Bypass the per-credential cache. */
  forceRefresh?: boolean;
  log?: EngineLogger;
  signal?: AbortSignal;
  /** Persist a refreshed Copilot token back to the caller's store. */
  onCredentialsRefreshed?: (token: CopilotTokenUpdate) => void | Promise<void>;
}

export interface CopilotTokenUpdate {
  copilotToken: string;
  copilotTokenExpiresAt?: string | number | null;
}

/** Upstream catalog row (only the fields the filter reads). */
interface CopilotRawModel {
  id?: string;
  name?: string;
  capabilities?: { type?: string };
  policy?: { state?: string };
}

interface CopilotFetchError extends Error {
  status?: number;
}

/** @type {Map<string, { expiresAt: number, models: CopilotModelEntry[] }>} */
const catalogCache = new Map<string, { expiresAt: number; models: CopilotModelEntry[] }>();

function cacheKey(credentials: Credentials) {
  return String(
    credentials?.providerSpecificData?.copilotToken
    || credentials?.accessToken
    || "copilot-anonymous"
  );
}

function buildHeaders(token: string) {
  return {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
    "Copilot-Integration-Id": "vscode-chat",
    "editor-version": `vscode/${GITHUB_COPILOT.VSCODE_VERSION}`,
    "editor-plugin-version": `copilot-chat/${GITHUB_COPILOT.COPILOT_CHAT_VERSION}`,
    "user-agent": GITHUB_COPILOT.USER_AGENT,
    "x-github-api-version": GITHUB_COPILOT.API_VERSION,
  };
}

async function fetchCatalogRaw(token: string, signal?: AbortSignal) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await proxyAwareFetch(MODELS_URL, {
      method: "GET",
      headers: buildHeaders(token),
      cache: "no-store",
      signal: signal || controller.signal,
    });
    if (!response.ok) {
      const err: CopilotFetchError = new Error(`Copilot /models returned ${response.status}`);
      err.status = response.status;
      throw err;
    }
    const data = await response.json();
    return Array.isArray(data?.data) ? data.data : [];
  } finally {
    clearTimeout(timeoutId);
  }
}

// Keep only chat models the account is allowed to use. The static registry
// surfaced disabled/embedding entries inconsistently; here we trust upstream.
function expandCatalog(raw: CopilotRawModel[]) {
  const seen = new Set<string>();
  const models: CopilotModelEntry[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    if (m.capabilities?.type !== "chat") continue;
    if (m.policy && m.policy.state !== "enabled") continue;
    const id = m.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name: m.name || id });
  }
  return models;
}

/**
 * Resolve the live Copilot model catalog for a connection.
 *
 * @param {object} credentials Connection record (accessToken, refreshToken,
 *   providerSpecificData {copilotToken, copilotTokenExpiresAt}).
 * @param {object} [options]
 * @param {boolean} [options.forceRefresh] Bypass the per-credential cache.
 * @param {object}  [options.log] Logger.
 * @param {function} [options.onCredentialsRefreshed] Persist a refreshed
 *   Copilot token back to your store. Called with `{ copilotToken,
 *   copilotTokenExpiresAt }` whenever a 401 triggers a refresh.
 * @returns {Promise<{ models: object[] } | null>}
 */
export async function resolveCopilotModels(
  credentials: Credentials,
  options: ResolveCopilotModelsOptions = {}
): Promise<{ models: CopilotModelEntry[] } | null> {
  const token = credentials?.providerSpecificData?.copilotToken || credentials?.accessToken;
  if (!token) {
    options.log?.debug?.("COPILOT_MODELS", "No copilotToken/accessToken; skipping live fetch");
    return null;
  }

  const key = cacheKey(credentials);
  const now = Date.now();
  if (!options.forceRefresh) {
    const cached = catalogCache.get(key);
    if (cached && cached.expiresAt > now) {
      return { models: cached.models };
    }
  }

  let raw: CopilotRawModel[];
  try {
    raw = await fetchCatalogRaw(String(token), options.signal);
  } catch (err) {
    const status = (err as CopilotFetchError | undefined)?.status;
    // A 401/403 means the Copilot token is stale - refresh from the GitHub
    // access token and retry once.
    if (err && (status === 401 || status === 403) && credentials.accessToken) {
      options.log?.info?.("COPILOT_MODELS", `Got ${status}; refreshing Copilot token`);
      const refreshed = await refreshCopilotToken(credentials.accessToken);
      if (refreshed?.token) {
        if (typeof options.onCredentialsRefreshed === "function") {
          try {
            await options.onCredentialsRefreshed({
              copilotToken: refreshed.token,
              copilotTokenExpiresAt: refreshed.expiresAt,
            });
          } catch (e) {
            options.log?.warn?.("COPILOT_MODELS", `onCredentialsRefreshed failed: ${(e as Error)?.message || e}`);
          }
        }
        try {
          raw = await fetchCatalogRaw(refreshed.token, options.signal);
        } catch (err2) {
          options.log?.warn?.("COPILOT_MODELS", `Retry after refresh failed: ${(err2 as Error)?.message || err2}`);
          return null;
        }
      } else {
        options.log?.warn?.("COPILOT_MODELS", "Token refresh did not return a token");
        return null;
      }
    } else {
      options.log?.warn?.("COPILOT_MODELS", `Live model fetch failed: ${(err as Error)?.message || err}`);
      return null;
    }
  }

  const models = expandCatalog(raw);
  if (!models.length) return null;

  catalogCache.set(key, { expiresAt: now + CACHE_TTL_MS, models });
  return { models };
}

export function clearCopilotModelCache() {
  catalogCache.clear();
}
