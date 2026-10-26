// OpenRouter video jobs - https://openrouter.ai/docs/api/api-reference/videos
//
// Same async shape as xAI (POST → { id, status }, GET → status/unsigned_urls),
// two differences only: creation POSTs to the collection root (no `/generations`
// suffix) and the account headers come from the registry entry.
// Response bodies are passed through verbatim.

// ponytail: generations only - OpenRouter has no edits/extensions endpoint today.
import type { MediaAdapterRequestOptions, MediaRequestPlan } from "../../types";

const SUPPORTED_ACTIONS = new Set(["generations"]);

function headers(config, token): Record<string, string> {
  return {
    Accept: "application/json",
    ...((config?.headers as Record<string, string> | undefined) || {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

const Openrouter = {
  buildRequest({ config, action, requestId, rawBody, contentType, token }: MediaAdapterRequestOptions): MediaRequestPlan {
    const base = config.baseUrl.replace(/\/$/, "");

    if (requestId) {
      return { method: "GET", url: `${base}/${encodeURIComponent(requestId)}`, headers: headers(config, token) };
    }
    if (!SUPPORTED_ACTIONS.has(action)) {
      return { error: `OpenRouter video supports 'generations' only (got '${action}')` };
    }
    if (contentType && !contentType.includes("application/json")) {
      return { error: "OpenRouter video requires an application/json body" };
    }
    return {
      method: "POST",
      url: base,
      headers: { ...headers(config, token), "Content-Type": "application/json" },
      body: rawBody,
    };
  },
};

export default Openrouter;
