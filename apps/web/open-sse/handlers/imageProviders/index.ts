// Image provider adapter registry

import antigravity from "./antigravity.ts"
import blackForestLabs from "./blackForestLabs.ts"
import chatgptWeb from "./chatgpt-web.ts"
import cloudflareAi from "./cloudflareAi.ts"
import codex from "./codex.ts"
import comfyui from "./comfyui.ts"
import falAi from "./falAi.ts"
import gemini from "./gemini.ts"
import geminiWeb from "./gemini-web.ts"
import grokWeb from "./grok-web.ts"
import huggingface from "./huggingface.ts"
import museWeb from "./muse-web.ts"
import nanobanana from "./nanobanana.ts"
import createOpenAIAdapter from "./openai.ts"
import runwayml from "./runwayml.ts"
import sdwebui from "./sdwebui.ts"
import stabilityAi from "./stabilityAi.ts"
import ucWeb from "./uc-web.ts"
import veoAiFreeWeb from "./veoaifree-web.ts"

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
}

export function getImageAdapter(provider) {
	return ADAPTERS[provider] || null
}

export function isImageProvider(provider) {
	return provider in ADAPTERS
}
