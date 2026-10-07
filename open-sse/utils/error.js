import { ERROR_TYPES, DEFAULT_ERROR_MESSAGES } from "../config/errorConfig.js";
import { FORMATS } from "../translator/formats.js";

// Anthropic's Messages API wraps every error in an event envelope:
//   { "type": "error", "error": { "type": "...", "message": "..." } }
// An OpenAI-shaped body ({ error: { message } }) is unparseable by the official
// SDKs, which surface it as a generic APIConnectionError. Error type names here
// mirror the documented Anthropic values, with humanizer messages ("Invalid
// request body" vs "Bad request") matching what the official API returns.
const ANTHROPIC_ERROR_TYPES = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  429: "rate_limit_error",
  500: "api_error",
  502: "api_error",
  503: "overloaded_error",
  504: "api_error",
};

const ANTHROPIC_ERROR_MESSAGES = {
  400: "Invalid request body",
  401: "Invalid API key",
  403: "Permission denied",
  404: "Resource not found",
  429: "Rate limit exceeded",
  500: "Internal server error",
  502: "Bad gateway",
  503: "Overloaded",
  504: "Gateway timeout",
};

function anthropicErrorType(statusCode) {
  return ANTHROPIC_ERROR_TYPES[statusCode] || "api_error";
}

/**
 * Build the protocol-specific error response body.
 * OpenAI-compatible clients (openai-python, AI SDK, curl) expect
 * `{ error: { message, type, code } }`; Anthropic clients expect the Messages
 * API envelope `{ type: "error", error: { type, message } }`.
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @param {string} [clientFormat] - FORMATS.CLAUDE → Anthropic envelope, else OpenAI
 * @returns {object} Error response body
 */
export function buildErrorBody(statusCode, message, clientFormat = null) {
  const errorInfo = ERROR_TYPES[statusCode] || 
    (statusCode >= 500 
      ? { type: "server_error", code: "internal_server_error" }
      : { type: "invalid_request_error", code: "" });

  if (clientFormat === FORMATS.CLAUDE) {
    return {
      type: "error",
      error: {
        type: anthropicErrorType(statusCode),
        message: message || ANTHROPIC_ERROR_MESSAGES[statusCode] || DEFAULT_ERROR_MESSAGES[statusCode] || "An error occurred",
      },
    };
  }

  return {
    error: {
      message: message || DEFAULT_ERROR_MESSAGES[statusCode] || "An error occurred",
      type: errorInfo.type,
      code: errorInfo.code
    }
  };
}

/**
 * Create error Response object (for non-streaming)
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @param {object} [extraHeaders] - Extra headers
 * @param {string} [clientFormat] - FORMATS.CLAUDE → Anthropic error envelope, else OpenAI
 * @returns {Response} HTTP Response object
 */
export function errorResponse(statusCode, message, extraHeaders = null, clientFormat = null) {
  return new Response(JSON.stringify(buildErrorBody(statusCode, message, clientFormat)), {
    status: statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders
    }
  });
}

/**
 * Write error to SSE stream (for streaming)
 * Emits the protocol's error frame: Claude `event: error` with the envelope,
 * OpenAI `data: {error...}` + [DONE].
 * @param {WritableStreamDefaultWriter} writer - Stream writer
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @param {string} [clientFormat] - FORMATS.CLAUDE → Anthropic envelope, else OpenAI
 */
export async function writeStreamError(writer, statusCode, message, clientFormat = null) {
  const errorBody = buildErrorBody(statusCode, message, clientFormat);
  const encoder = new TextEncoder();
  const frame = clientFormat === FORMATS.CLAUDE
    ? `event: error\ndata: ${JSON.stringify(errorBody)}\n\n`
    : `data: ${JSON.stringify(errorBody)}\n\n`;
  await writer.write(encoder.encode(frame));
}

/**
 * Parse upstream provider error response
 * @param {Response} response - Fetch response from provider
 * @param {object} [executor] - Optional executor with parseError() override for provider-specific parsing
 * @returns {Promise<{statusCode: number, message: string, resetsAtMs?: number}>}
 */
export async function parseUpstreamError(response, executor = null) {
  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch {
    bodyText = "";
  }

  // Let executor-specific parser extract provider-specific fields (e.g. codex resetsAtMs)
  if (executor && typeof executor.parseError === "function") {
    try {
      const parsed = executor.parseError(response, bodyText);
      if (parsed && typeof parsed === "object") {
        const msg = parsed.message || DEFAULT_ERROR_MESSAGES[response.status] || `Upstream error: ${response.status}`;
        return { statusCode: parsed.status || response.status, message: msg, resetsAtMs: parsed.resetsAtMs };
      }
    } catch { /* fall through to default parsing */ }
  }

  let message = "";
  try {
    const json = JSON.parse(bodyText);
    message = json.error?.message || json.message || json.error || bodyText;
  } catch {
    message = bodyText;
  }

  const messageStr = typeof message === "string" ? message : JSON.stringify(message);
  const finalMessage = messageStr || DEFAULT_ERROR_MESSAGES[response.status] || `Upstream error: ${response.status}`;

  return { statusCode: response.status, message: finalMessage };
}

/**
 * Create error result for chatCore handler
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @param {number} [resetsAtMs] - Optional precise cooldown expiry (ms epoch) for provider-specific quota errors
 * @returns {{ success: false, status: number, error: string, response: Response, resetsAtMs?: number }}
 */
export function createErrorResult(statusCode, message, resetsAtMs, extraHeaders = null, clientFormat = null) {
  return {
    success: false,
    status: statusCode,
    error: message,
    resetsAtMs,
    response: errorResponse(statusCode, message, extraHeaders, clientFormat)
  };
}

/**
 * Create unavailable response when all accounts are rate limited
 * @param {number} statusCode - Original error status code
 * @param {string} message - Error message (without retry info)
 * @param {string} retryAfter - ISO timestamp when earliest account becomes available
 * @param {string} retryAfterHuman - Human-readable retry info e.g. "reset after 30s"
 * @param {object} [extraHeaders] - Upstream headers to forward
 * @param {string} [clientFormat] - FORMATS.CLAUDE → Anthropic envelope, else OpenAI
 * @returns {Response}
 */
export function unavailableResponse(statusCode, message, retryAfter, retryAfterHuman, extraHeaders = null, clientFormat = null) {
  const retryAfterSec = Math.max(Math.ceil((new Date(retryAfter).getTime() - Date.now()) / 1000), 1);
  const msg = `${message} (${retryAfterHuman})`;
  const body = buildErrorBody(statusCode, msg, clientFormat);
  return new Response(
    JSON.stringify(body),
    {
      status: statusCode,
      headers: {
        ...extraHeaders,
        "Content-Type": "application/json",
        // Intentionally mis-cased to prevent duplicate headers
        "retry-after": String(retryAfterSec)
      }
    }
  );
}

/**
 * Format provider error with context
 * @param {Error} error - Original error
 * @param {string} provider - Provider name
 * @param {string} model - Model name
 * @param {number|string} statusCode - HTTP status code or error code
 * @returns {string} Formatted error message
 */
export function formatProviderError(error, provider, model, statusCode) {
  const code = statusCode || error.code || "FETCH_FAILED";
  const message = error.message || "Unknown error";
  // Expose low-level cause (e.g. UND_ERR_SOCKET, ECONNRESET, ETIMEDOUT) for diagnosing fetch failures
  const causeCode = error.cause?.code;
  const causeMsg = error.cause?.message;
  const causeStr = causeCode || causeMsg ? ` (cause: ${[causeCode, causeMsg].filter(Boolean).join(": ")})` : "";
  return `[${code}]: ${message}${causeStr}`;
}
