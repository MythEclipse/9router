import { Buffer } from "node:buffer"
import { PROVIDER_ID_TO_ALIAS, PROVIDER_MODELS } from "../config/providerModels.ts"
import { HTTP_STATUS } from "../config/runtimeConfig.ts"
import { createErrorResult } from "../utils/error.ts"
import { transcribeCodex } from "./codexStt.ts"
import { transcribeGeminiLive } from "./geminiLiveStt.ts"

export function textResponse(body) {
	return {
		success: true,
		response: new Response(body, {
			status: 200,
			headers: { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" },
		}),
	}
}

// HuggingFace: POST raw binary to {baseUrl}/{model_id}

export function jsonResponse(obj) {
	return {
		success: true,
		response: new Response(JSON.stringify(obj), {
			status: 200,
			headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
		}),
	}
}

// Model-level transport marker (registry models[].transport, e.g. the Gemini
// live STT entry's "gemini-live", or a custom model's stored transport).
// Dispatch reads the marker - never a hardcoded model id - so new realtime
// providers extend sttCore through data, not code.
