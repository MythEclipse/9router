import { FORMATS } from "open-sse/translator/formats.js";
import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";

// Fields that belong to other wire protocols and are rejected by Anthropic's
// Messages API ("Unknown parameter"). Rejecting them here returns a clean,
// protocol-shaped 400 instead of an opaque upstream error.
const OPENAI_ONLY_FIELDS = new Set([
  "stream_options",
  "response_format",
  "logprobs",
  "top_logprobs",
  "n",
  "presence_penalty",
  "frequency_penalty",
  "logit_bias",
  "user",
]);

export function isClaudeEndpoint(pathname) {
  if (!pathname) return false;
  // /v1/messages (stream or plain), /v1/messages/count_tokens and any
  // anthropic-format alias route. detectFormatByEndpoint uses the same rule.
  return pathname === "/v1/messages" || pathname.startsWith("/v1/messages/");
}

/**
 * Validate an Anthropic Messages request body strictly enough that official
 * SDK behavior is preserved: `max_tokens` is REQUIRED (the API rejects bodies
 * without it, and Anthropic's SDK surfaces its absence as a validation error
 * before even sending), and `messages` must be a non-empty array.
 * Returns null when valid, or the error Response otherwise.
 */
export function validateClaudeMessageBody(body) {
  const badRequest = (message) =>
    errorResponse(HTTP_STATUS.BAD_REQUEST, message, null, FORMATS.CLAUDE);

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return badRequest("Invalid request body");
  }

  if (body.max_tokens === undefined) {
    return badRequest("max_tokens: field required: this field is required and must be provided");
  }
  if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1) {
    return badRequest("max_tokens: must be an integer greater than 0");
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return badRequest("messages: at least one message is required");
  }

  const foreign = Object.keys(body).filter((key) => OPENAI_ONLY_FIELDS.has(key));
  if (foreign.length > 0) {
    const names = foreign.map((key) => `'${key}'`).join(", ");
    return badRequest(`Unsupported parameter(s): ${names}. This endpoint speaks the Anthropic Messages protocol.`);
  }

  return null;
}