// Image provider adapter registry
import createOpenAIAdapter from "./openai";
import gemini from "./gemini";
import codex from "./codex";
import sdwebui from "./sdwebui";
import comfyui from "./comfyui";
import huggingface from "./huggingface";
import nanobanana from "./nanobanana";
import falAi from "./falAi";
import stabilityAi from "./stabilityAi";
import blackForestLabs from "./blackForestLabs";
import runwayml from "./runwayml";
import cloudflareAi from "./cloudflareAi";
import antigravity from "./antigravity";
import museWeb from "./muse-web";
import chatgptWeb from "./chatgpt-web";
import geminiWeb from "./gemini-web";
import grokWeb from "./grok-web";
import veoAiFreeWeb from "./veoaifree-web";
import ucWeb from "./uc-web";

const ADAPTERS = {
  openai: createOpenAIAdapter("openai"),
  minimax: createOpenAIAdapter("minimax"),
  openrouter: createOpenAIAdapter("openrouter"),
  recraft: createOpenAIAdapter("recraft"),
  "vercel-ai-gateway": createOpenAIAdapter("vercel-ai-gateway"),
  xai: createOpenAIAdapter("xai"),
  sensenova: createOpenAIAdapter("sensenova"),
  gemini,
  codex,
  sdwebui,
  comfyui,
  huggingface,
  nanobanana,
  antigravity,
  "fal-ai": falAi,
  "stability-ai": stabilityAi,
  "black-forest-labs": blackForestLabs,
  runwayml,
  "cloudflare-ai": cloudflareAi,
  "muse-web": museWeb,
  "chatgpt-web": chatgptWeb,
  "gemini-web": geminiWeb,
  "grok-web": grokWeb,
  "veoaifree-web": veoAiFreeWeb,
  "uc-web": ucWeb,
};

export function getImageAdapter(provider) {
  return ADAPTERS[provider] || null;
}

export function isImageProvider(provider) {
  return provider in ADAPTERS;
}
