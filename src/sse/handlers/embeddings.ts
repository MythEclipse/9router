import {
  getProviderCredentials,
  markAccountUnavailable,
  shouldTryNextAccount,
  clearAccountError,
  extractApiKey,
  apiKeyGateFailure,
  isValidApiKey,
  shouldLogAuthFailure,
} from "../services/auth";
import { getSettings } from "@/lib/localDb";
import { getClientIp } from "@/lib/auth/loginLimiter";
import { getModelInfo } from "../services/model";
import { getKeyAccessContext, enforceKeyAccessResolved } from "../services/keyAccess";
import { handleEmbeddingsCore } from "open-sse/handlers/embeddingsCore";
import { errorResponse } from "open-sse/utils/error";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig";
import * as log from "../utils/logger";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh";
import { saveRequestUsage } from "@/lib/usageDb";
import { unavailableCredentialResponse } from "../services/accountFallbackLoop";

/** Token counts an embeddings provider reports back for one request. */
interface EmbeddingUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  [key: string]: number | undefined;
}

/** The error arm of an embeddingsCore result. */
interface EmbeddingsFailure {
  success: false;
  status: number;
  error: string;
  response: Response;
}

/** The success arm - carries the provider-reported usage when it is exact. */
interface EmbeddingsSuccess {
  success: true;
  usage: EmbeddingUsage | null;
  response: Response;
}

function exactEmbeddingUsage(raw): EmbeddingUsage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.estimated === true) return null;
  const promptTokens = raw.prompt_tokens ?? raw.input_tokens;
  const completionTokens = raw.completion_tokens ?? raw.output_tokens ?? 0;
  const totalTokens = raw.total_tokens;
  if (!Number.isSafeInteger(promptTokens) || promptTokens <= 0 || completionTokens !== 0 || totalTokens !== promptTokens) return null;
  return { prompt_tokens: promptTokens, completion_tokens: 0, total_tokens: totalTokens };
}

/**
 * Handle embeddings request for the SSE/Next.js server.
 * Follows the same auth + fallback pattern as handleChat.
 *
 * @param {Request} request
 */
export async function handleEmbeddings(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("EMBEDDINGS", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const url = new URL(request.url);
  const modelStr = body.model;

  log.request("POST", `${url.pathname} | ${modelStr}`);

  // Log API key (masked)
  const apiKey = extractApiKey(request);
  if (apiKey) {
    log.debug("AUTH", `API Key: ${log.maskKey(apiKey)}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  if (settings.requireApiKey && !apiKey) {
    if (shouldLogAuthFailure("embeddings", getClientIp(request), null)) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
    }
    return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
  }
  if (apiKey) {
    const failure = apiKeyGateFailure(await isValidApiKey(apiKey), settings.requireApiKey);
    if (failure) {
      if (shouldLogAuthFailure("embeddings", getClientIp(request), apiKey.slice(0, 8))) {
        log.warn("AUTH", `${failure.message} (requireApiKey=${settings.requireApiKey})`);
      }
      return errorResponse(failure.status, failure.message);
    }
  }

  if (!modelStr) {
    log.warn("EMBEDDINGS", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  if (!body.input) {
    log.warn("EMBEDDINGS", "Missing input");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: input");
  }

  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) {
    log.warn("EMBEDDINGS", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;
  // A studio name is the model the caller owns, so its usage belongs to that name.
  const requestedModel = modelStr && modelStr !== `${provider}/${model}` ? modelStr : null;

  // Per-key access control: checked before any credential lookup.
  const keyAccessDenied = await enforceKeyAccessResolved(await getKeyAccessContext(request), modelStr, provider, model);
  if (keyAccessDenied) return keyAccessDenied;

  if (modelStr !== `${provider}/${model}`) {
    log.info("ROUTING", `${modelStr} → ${provider}/${model}`);
  } else {
    log.info("ROUTING", `Provider: ${provider}, Model: ${model}`);
  }

  // Credential + fallback loop (mirrors handleChat)
  const excludeConnectionIds = new Set<string>();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model);

    // All accounts unavailable
    const unavailable = unavailableCredentialResponse({
      credentials, excludeConnectionIds, lastError, lastStatus,
      subject: provider, label: "EMBEDDINGS",
      cooldownSubject: requestedModel || `${provider}/${model}`,
    });
    if (unavailable) return unavailable;

    log.info("AUTH", `\x1b[32mUsing ${provider} account: ${credentials.connectionName}\x1b[0m`);

    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    const result = await handleEmbeddingsCore({
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          ...newCreds,
          existingProviderSpecificData: credentials.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
      }
    });

    if (result.success) {
      const success = result as EmbeddingsSuccess;
      const usage = exactEmbeddingUsage(success.usage);
      if (usage) {
        saveRequestUsage({
        requestedModel,
          provider,
          model,
          connectionId: credentials.connectionId,
          apiKey,
          endpoint: url.pathname,
          tokens: usage,
          status: "success",
        }).catch(() => {});
      }
      return success.response;
    }

    // A failed result is always the error envelope: status/error are present.
    const failure = result as EmbeddingsFailure;
    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, failure.status, failure.error, provider, model);

    if (shouldTryNextAccount(credentials.connectionId, failure.status, shouldFallback)) {
      log.warn("AUTH", `Account ${credentials.connectionName} unavailable (${failure.status}), trying fallback`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = failure.error;
      lastStatus = failure.status;
      continue;
    }

    return failure.response;
  }
}
