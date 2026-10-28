// TTS provider registry

import { parseModelVoice } from "./_base.ts"
import edgeTts, { fetchEdgeTtsVoices } from "./edgeTts.ts"
import elevenlabs, { fetchElevenLabsVoices } from "./elevenlabs.ts"
import gemini, { fetchGeminiVoices } from "./gemini.ts"
import { FORMAT_HANDLERS } from "./genericFormats.ts"
import googleTts from "./googleTts.ts"
import localDevice, { fetchLocalDeviceVoices } from "./localDevice.ts"
import ollamaLocal from "./ollamaLocal.ts"
import openai from "./openai.ts"
import openrouter from "./openrouter.ts"
import selfhostedTts from "./selfhostedTts.ts"
import xiaomiMimo from "./xiaomi-mimo.ts"

// Special providers with custom synthesize() logic
const SPECIAL_ADAPTERS = {
	"google-tts": googleTts,
	"edge-tts": edgeTts,
	"local-device": localDevice,
	elevenlabs,
	openai,
	openrouter,
	gemini,
	"xiaomi-mimo": xiaomiMimo,
	"selfhosted-tts": selfhostedTts,
	"ollama-local": ollamaLocal,
}

export function getTtsAdapter(provider) {
	return SPECIAL_ADAPTERS[provider] || null
}

// Generic config-driven dispatcher (uses ttsConfig.format)
export async function synthesizeViaConfig(provider, text, model, credentials) {
	const { AI_PROVIDERS } = await import("@/shared/constants/providers")
	const cfg = AI_PROVIDERS[provider]?.ttsConfig
	if (!cfg) return null
	const handler = FORMAT_HANDLERS[cfg.format]
	if (!handler) return null
	const apiKey = credentials?.apiKey
	if (cfg.authType !== "none" && !apiKey) throw new Error(`${provider} API key required`)
	const { PROVIDER_MODELS } = await import("open-sse/config/providerModels")
	const ttsModels = (PROVIDER_MODELS[provider] || []).filter((m) => (m.kind || m.type) === "tts")
	const defaultModel = ttsModels[0]?.id || ""
	const { modelId, voiceId } = parseModelVoice(model, defaultModel, "", ttsModels)
	return handler({ baseUrl: cfg.baseUrl, apiKey, text, modelId, voiceId })
}

// Voice fetchers (used by /api/media-providers/tts/voices route)
export const VOICE_FETCHERS = {
	"edge-tts": fetchEdgeTtsVoices,
	"local-device": fetchLocalDeviceVoices,
	elevenlabs: fetchElevenLabsVoices,
	gemini: fetchGeminiVoices,
}

export type { ElevenLabsVoice } from "./elevenlabs.ts"
// Re-export for backward compat
export { fetchEdgeTtsVoices, fetchElevenLabsVoices, fetchGeminiVoices, fetchLocalDeviceVoices }
