import { HTTP_STATUS, DEFAULT_RETRY_CONFIG, resolveRetryEntry, FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.ts";
import type { RetryEntry } from "../config/runtimeConfig.ts";
import { shouldRefreshCredentials } from "../services/oauthCredentialManager.ts";
import { proxyAwareFetch } from "../utils/proxyFetch.ts";
import { dbg } from "../utils/debugLog.ts";
import { ANTHROPIC_API_VERSION, OPENAI_COMPAT_BASE, ANTHROPIC_COMPAT_BASE } from "../providers/shared.ts";
import { resolveOpenAICompatibleApiType } from "../services/provider.ts";
import type { TransportConfig } from "../providers/schema.ts";
import type {
  ChatRequestBody,
  Credentials,
  EngineLogger,
  ExecuteOptions,
  ExecutorResult,
  ProxyOptions,
  ProviderOverrides,
} from "../types.ts";

/** Retry bookkeeping is per base-URL index. */
type RetryAttempts = Record<number, number>;

/**
 * BaseExecutor - Base class for provider executors
 */
export class BaseExecutor {
  provider: string;
  config: TransportConfig;
  noAuth: boolean;

  constructor(provider: string, config: TransportConfig) {
    this.provider = provider;
    this.config = config;
    this.noAuth = Boolean((config as { noAuth?: boolean })?.noAuth);
  }

  getProvider(): string {
    return this.provider;
  }

  getBaseUrls(): string[] {
    const config = this.config as TransportConfig & { baseUrls?: string[] };
    return config.baseUrls || (config.baseUrl ? [config.baseUrl] : []);
  }

  getFallbackCount(): number {
    return this.getBaseUrls().length || 1;
  }

  buildUrl(
    model: string,
    stream?: boolean,
    urlIndex = 0,
    credentials: Credentials | null = null
  ): string {
    if (this.provider?.startsWith?.("openai-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || OPENAI_COMPAT_BASE;
      const normalized = String(baseUrl).replace(/\/$/, "");
      const path = resolveOpenAICompatibleApiType(this.provider, credentials) === "responses" ? "/responses" : "/chat/completions";
      return `${normalized}${path}`;
    }
    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || ANTHROPIC_COMPAT_BASE;
      const normalized = String(baseUrl).replace(/\/$/, "");
      return `${normalized}/messages`;
    }
    const baseUrls = this.getBaseUrls();
    return baseUrls[urlIndex] || baseUrls[0] || this.config.baseUrl || "";
  }

  /**
   * Provider headers. Subclasses widen this signature (url/model/body are
   * needed by fingerprint- and body-signing providers), so the optional tail
   * is part of the base contract even though the base implementation ignores it.
   */
  buildHeaders(
    credentials: Credentials,
    stream = true,
    _url?: string | null,
    _model?: string | null,
    _body?: ChatRequestBody | null
  ): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.config.headers
    };

    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      // Anthropic-compatible providers use x-api-key header
      if (credentials.apiKey) {
        headers["x-api-key"] = credentials.apiKey;
      } else if (credentials.accessToken) {
        headers["Authorization"] = `Bearer ${credentials.accessToken}`;
      }
      if (!headers["anthropic-version"]) {
        headers["anthropic-version"] = ANTHROPIC_API_VERSION;
      }
    } else {
      // Standard Bearer token auth for other providers
      if (credentials.accessToken) {
        headers["Authorization"] = `Bearer ${credentials.accessToken}`;
      } else if (credentials.apiKey) {
        headers["Authorization"] = `Bearer ${credentials.apiKey}`;
      }
    }

    if (stream) {
      headers["Accept"] = "text/event-stream";
    }

    return headers;
  }

  // Override in subclass for provider-specific transformations
  transformRequest(
    _model: string,
    body: ChatRequestBody,
    _stream?: boolean,
    _credentials?: Credentials | null
  ): ChatRequestBody {
    return body;
  }

  shouldRetry(status: number, urlIndex: number): boolean {
    return status === HTTP_STATUS.RATE_LIMITED && urlIndex + 1 < this.getFallbackCount();
  }

  // Override in subclass for provider-specific refresh
  async refreshCredentials(
    _credentials: Credentials,
    _log?: EngineLogger,
    _proxyOptions?: ProxyOptions | null
  ): Promise<Credentials | null> {
    return null;
  }

  needsRefresh(credentials: Credentials): boolean {
    return shouldRefreshCredentials(this.provider, credentials);
  }

  parseError(response: Response, bodyText: string): { status: number; message: string } {
    return { status: response.status, message: bodyText || `HTTP ${response.status}` };
  }

  /**
   * Optional subclass hook: derive a dynamic retry delay from the response.
   * Returning `false` vetoes the retry (e.g. Retry-After is too long), `null`
   * falls back to the configured delay.
   */
  computeRetryDelay?(
    response: Response,
    attempt: number,
    defaultDelayMs: number
  ): Promise<number | false | null> | number | false | null;

  async execute({
    model,
    body,
    stream,
    credentials,
    signal,
    log,
    proxyOptions = null,
    providerOverrides = null,
    directFetch = null,
  }: ExecuteOptions): Promise<ExecutorResult> {
    const fallbackCount = this.getFallbackCount();
    let lastError: (Error & { name?: string }) | null = null;
    let lastStatus = 0;
    const retryAttemptsByUrl: RetryAttempts = {};

    // Merge default retry config with provider-specific config
    const retryConfig: Record<string, RetryEntry> = {
      ...DEFAULT_RETRY_CONFIG,
      ...(this.config.retry as Record<string, RetryEntry>),
    };

    // Schedule retry via retryConfig[statusKey]. Returns true when caller should `urlIndex--; continue`
    // response (optional) lets a subclass hook compute a dynamic delay (e.g. antigravity Retry-After).
    const tryRetry = async (
      urlIndex: number,
      statusKey: string,
      reason: string,
      response: Response | null = null
    ): Promise<boolean> => {
      const { attempts, delayMs } = resolveRetryEntry(retryConfig[statusKey]);
      if (attempts <= 0 || retryAttemptsByUrl[urlIndex] >= attempts) return false;
      // Hook: subclass may derive delay from the response (headers/body). null → skip retry, use fallback.
      let waitMs = delayMs;
      if (response && this.computeRetryDelay) {
        const dynamic = await this.computeRetryDelay(response, retryAttemptsByUrl[urlIndex] + 1, delayMs);
        if (dynamic === false) return false; // hook vetoes retry (e.g. Retry-After too long)
        if (dynamic != null) waitMs = dynamic;
      }
      retryAttemptsByUrl[urlIndex]++;
      log?.debug?.("RETRY", `${reason} retry ${retryAttemptsByUrl[urlIndex]}/${attempts} after ${waitMs / 1000}s`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
      return true;
    };

    for (let urlIndex = 0; urlIndex < fallbackCount; urlIndex++) {
      const url = this.buildUrl(model, stream, urlIndex, credentials ?? null);
      const transformedBody = this.transformRequest(model, body, stream, credentials ?? null);
      const headers = this.buildHeaders(credentials ?? {}, stream, url, model, transformedBody);
      // User per-provider override wins over registry headers (blocked names filtered at the API)
      if (providerOverrides?.headers) Object.assign(headers, providerOverrides.headers);

      if (!retryAttemptsByUrl[urlIndex]) retryAttemptsByUrl[urlIndex] = 0;

      // Abort if upstream doesn't return response headers within connection timeout
      const connectCtrl = new AbortController();
      const timeoutMs = this.config?.timeoutMs || FETCH_CONNECT_TIMEOUT_MS;
      const connectTimer = setTimeout(() => connectCtrl.abort(new Error("fetch connect timeout")), timeoutMs);
      const mergedSignal = signal ? AbortSignal.any([signal, connectCtrl.signal]) : connectCtrl.signal;

      try {
        const bodyStr = JSON.stringify(transformedBody);
        const fetchT0 = Date.now();
        dbg("FETCH", `${this.provider.toUpperCase()} → ${url} | body=${bodyStr.length}B | connectTimeout=${timeoutMs}ms`);
        const response = await proxyAwareFetch(url, {
          method: "POST",
          headers,
          body: bodyStr,
          signal: mergedSignal
        }, proxyOptions, directFetch);
        clearTimeout(connectTimer);
        const ct = response.headers?.get?.("content-type") || "";
        const cl = response.headers?.get?.("content-length") || "?";
        dbg("FETCH", `${this.provider.toUpperCase()} ← ${response.status} | ttft=${Date.now() - fetchT0}ms | ct=${ct} | cl=${cl}`);

        if (await tryRetry(urlIndex, String(response.status), `status ${response.status}`, response)) { urlIndex--; continue; }

        if (this.shouldRetry(response.status, urlIndex)) {
          log?.debug?.("RETRY", `${response.status} on ${url}, trying fallback ${urlIndex + 1}`);
          lastStatus = response.status;
          continue;
        }

        return { response, url, headers, transformedBody };
      } catch (caught) {
        clearTimeout(connectTimer);
        const error = caught as Error & { name?: string };
        lastError = error;
        const isConnectTimeout = connectCtrl.signal.aborted && error.name === "AbortError";
        dbg("FETCH", `${this.provider.toUpperCase()} ✖ ${error.name}: ${error.message}${isConnectTimeout ? " (connect timeout)" : ""}`);
        // Connect timeout is internal - convert to retryable network error, don't propagate AbortError
        if (error.name === "AbortError" && !isConnectTimeout) throw error;

        // Map network/fetch exceptions to 502 retry config
        if (await tryRetry(urlIndex, String(HTTP_STATUS.BAD_GATEWAY), `network "${error.message}"`)) { urlIndex--; continue; }

        if (urlIndex + 1 < fallbackCount) {
          log?.debug?.("RETRY", `Error on ${url}, trying fallback ${urlIndex + 1}`);
          continue;
        }
        throw error;
      }
    }

    throw lastError || new Error(`All ${fallbackCount} URLs failed with status ${lastStatus}`);
  }
}

export default BaseExecutor;
