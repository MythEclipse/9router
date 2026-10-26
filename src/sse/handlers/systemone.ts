import {
  getProviderCredentials,
  markAccountUnavailable,
  shouldTryNextAccount,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
  shouldLogAuthFailure,
} from "../services/auth";
import { getSettings } from "@/lib/localDb";
import { getClientIp } from "@/lib/auth/loginLimiter";
import { getModelInfo } from "../services/model";
import { getKeyAccessContext, enforceKeyAccessResolved } from "../services/keyAccess";
import { handleSystemoneCore } from "open-sse/handlers/systemoneCore";
import { errorResponse } from "open-sse/utils/error";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig";
import * as log from "../utils/logger";
import { checkAndRefreshToken } from "../services/tokenRefresh";
import { saveRequestUsage } from "@/lib/usageDb";
import { unavailableCredentialResponse } from "../services/accountFallbackLoop";

/**
 * Handle System One (Jev) decision requests for the Next.js server.
 * Follows the same auth + account-fallback pattern as handleEmbeddings.
 *
 * @param {Request} request
 */
export async function handleSystemone(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("SYSTEMONE", "Invalid JSON body");
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
  if (settings.requireApiKey) {
    if (!apiKey) {
      if (shouldLogAuthFailure("systemone", getClientIp(request), null)) {
        log.warn("AUTH", "Missing API key (requireApiKey=true)");
      }
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      if (shouldLogAuthFailure("systemone", getClientIp(request), apiKey.slice(0, 8))) {
        log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      }
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  if (!modelStr) {
    log.warn("SYSTEMONE", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }
  if (body.state === undefined || body.state === null) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: state");
  }
  if (!body.questions || typeof body.questions !== "object" || Array.isArray(body.questions)) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: questions");
  }

  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) {
    log.warn("SYSTEMONE", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;

  // Per-key access control: checked before any credential lookup.
  const keyAccessDenied = await enforceKeyAccessResolved(await getKeyAccessContext(request), modelStr, provider, model);
  if (keyAccessDenied) return keyAccessDenied;

  if (modelStr !== `${provider}/${model}`) {
    log.info("ROUTING", `${modelStr} → ${provider}/${model}`);
  } else {
    log.info("ROUTING", `Provider: ${provider}, Model: ${model}`);
  }

  // Credential + fallback loop (mirrors handleEmbeddings)
  const excludeConnectionIds = new Set<string>();
  // Proxy pools already tried in THIS request (no-auth rotation strategies).
  const excludePoolIds = new Set<string>();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, { excludePoolIds });

    // All accounts unavailable
    const unavailable = unavailableCredentialResponse({
      credentials, excludeConnectionIds, lastError, lastStatus,
      subject: provider, label: "SYSTEMONE",
      cooldownSubject: `${provider}/${model}`,
    });
    if (unavailable) return unavailable;

    log.info("AUTH", `\x1b[32mUsing ${provider} account: ${credentials.connectionName}\x1b[0m`);

    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    const result = await handleSystemoneCore({
      body,
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
      }
    });

    if (result.success === true) {
      if (result.usage) {
        saveRequestUsage({
          provider,
          model,
          connectionId: credentials.connectionId,
          apiKey,
          endpoint: url.pathname,
          tokens: {
            ...result.usage,
            total_tokens: result.usage.prompt_tokens + result.usage.completion_tokens,
          },
          status: "success",
        }).catch(() => {});
      }
      return result.response;
    }

    const proxyPoolId = credentials.providerSpecificData?.connectionProxyPoolId;
    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, null, {
      excludePoolIds,
      proxyPoolId: typeof proxyPoolId === "string" ? proxyPoolId : null,
    });

    if (shouldTryNextAccount(credentials.connectionId, result.status, shouldFallback)) {
      log.warn("AUTH", `Account ${credentials.connectionName} unavailable (${result.status}), trying fallback`);
      excludeConnectionIds.add(credentials.connectionId);
      // Never hand this request the proxy that just failed again (no-auth rotation).
      const failedPoolId = credentials.providerSpecificData?.connectionProxyPoolId;
      if (typeof failedPoolId === "string") excludePoolIds.add(failedPoolId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result.response;
  }
}
