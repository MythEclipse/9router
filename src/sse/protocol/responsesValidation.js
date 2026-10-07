import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";

export function isResponsesEndpoint(pathname) {
  if (!pathname) return false;
  return pathname === "/v1/responses" || pathname.startsWith("/v1/responses/");
}

// OpenAI Responses API requires `input` (array/string) and `model`. Missing
// input currently falls through to the translator which returns the body
// unmodified, then the chat pipeline 502s. Reject early with the proper
// Responses error shape (plain OpenAI `{error}` envelope — Responses clients
// are OpenAI-ecosystem clients).
export function validateResponsesBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid request body");
  }
  if (body.input === undefined) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "input: field required: this field is required and must be provided");
  }
  if (typeof body.input !== "string" && !Array.isArray(body.input)) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "input: must be a string or an array of items");
  }
  return null;
}