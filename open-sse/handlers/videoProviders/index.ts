// Video provider adapters.
//
// Default (no adapter) = xAI shape: raw body forwarded to {baseUrl}/{action},
// polled at {baseUrl}/{id}, upstream JSON passed through verbatim.
// A provider only needs an adapter when its wire format differs from that.
import openrouter from "./openrouter.ts";
import vertex from "./vertex.ts";

const ADAPTERS = { openrouter, vertex };

export function getVideoAdapter(provider) {
  return ADAPTERS[provider] || null;
}
