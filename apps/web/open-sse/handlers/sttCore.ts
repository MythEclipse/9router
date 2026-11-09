import { Buffer } from "node:buffer"
import { PROVIDER_ID_TO_ALIAS, PROVIDER_MODELS } from "../config/providerModels.ts"
import { HTTP_STATUS } from "../config/runtimeConfig.ts"
import { createErrorResult } from "../utils/error.ts"
import { transcribeCodex } from "./codexStt.ts"
import { transcribeGeminiLive } from "./geminiLiveStt.ts"

import { buildAuthHeaders, resolveAudioContentType, upstreamError } from "./sttCommon.ts"
import { jsonResponse, textResponse } from "./sttFormats.ts"
import {
	transcribeAssemblyAI,
	transcribeDeepgram,
	transcribeGemini,
	transcribeNvidia,
} from "./sttGroup1.ts"
import { extractAdditionalFormat, transcribeElevenLabs } from "./sttGroup2.ts"

export { jsonResponse, textResponse } from "./sttFormats.ts"
export { extractAdditionalFormat } from "./sttGroup2.ts"

// HuggingFace: POST raw binary to {baseUrl}/{model_id}
async function transcribeHuggingFace(cfg, file, model, token) {
	if (model.includes("..") || model.includes("//")) return createErrorResult(400, "Invalid model ID")
	const url = `${cfg.baseUrl.replace(/\/+$/, "")}/${model}`
	const buf = await file.arrayBuffer()
	const res = await fetch(url, {
		method: "POST",
		headers: { ...buildAuthHeaders(cfg, token), "Content-Type": resolveAudioContentType(file) },
		body: buf,
	})
	if (!res.ok) return upstreamError(res)
	const data = await res.json()
	return jsonResponse({ text: data.text || "" })
}

// Default: OpenAI/Groq/Whisper-compatible multipart
async function transcribeOpenAICompatible(cfg, file, model, token, formData) {
	const fd = new FormData()
	fd.append("file", file, file.name || "audio.wav")
	fd.append("model", model)
	for (const k of ["language", "prompt", "response_format", "temperature"]) {
		const v = formData.get(k)
		if (v !== null && v !== undefined && v !== "") fd.append(k, v)
	}
	const res = await fetch(cfg.baseUrl, {
		method: "POST",
		headers: buildAuthHeaders(cfg, token),
		body: fd,
	})
	if (!res.ok) return upstreamError(res)
	const ct = res.headers.get("content-type") || "application/json"
	const txt = await res.text()
	return {
		success: true,
		response: new Response(txt, {
			status: 200,
			headers: { "Content-Type": ct, "Access-Control-Allow-Origin": "*" },
		}),
	}
}

function resolveModelTransport(provider, model) {
	const key = PROVIDER_ID_TO_ALIAS[provider] || provider
	const models = PROVIDER_MODELS[key] || PROVIDER_MODELS[provider]
	if (!Array.isArray(models)) return null
	const entry = models.find((m) => m && m.id === model && (m.kind || "llm") === "stt")
	const marker = typeof entry?.transport === "string" ? entry.transport.trim() : ""
	return marker || null
}

/**
 * STT core handler - dispatch by model transport marker, else sttConfig.format.
 * `transport` is the caller-supplied marker override (custom models resolve
 * it in the app layer; built-ins fall back to the registry entry marker).
 * @returns {Promise<{success, response, status?, error?}>}
 */
export async function handleSttCore({
	provider,
	model,
	formData,
	credentials,
	sttConfig,
	transport,
	signal,
	proxyOptions,
}) {
	const file = formData.get("file")
	if (!file) return createErrorResult(HTTP_STATUS.BAD_REQUEST, "Missing required field: file")

	let cfg = sttConfig
	if (!cfg)
		return createErrorResult(HTTP_STATUS.BAD_REQUEST, `Provider '${provider}' does not support STT`)

	// OAuth transcription uses a fixed ChatGPT endpoint; never honor connection URL overrides.
	if (provider === "codex" && cfg.format === "codex-transcribe") {
		return transcribeCodex({ formData, credentials, signal, proxyOptions })
	}

	// Per-connection endpoint override. Registry entries carry a fixed baseUrl,
	// which is right for a named cloud service but useless for a self-hosted one
	// whose address only the operator knows. Opt-in: absent unless the connection
	// sets it, so cloud providers are untouched. Mirrors the custom embedding
	// providers, which already resolve baseUrl the same way.
	const overrideUrl = credentials?.providerSpecificData?.baseUrl
	if (overrideUrl) cfg = { ...cfg, baseUrl: String(overrideUrl).replace(/\/+$/, "") }

	const token = cfg.authType === "none" ? null : credentials?.apiKey || credentials?.accessToken
	if (cfg.authType !== "none" && !token) {
		return createErrorResult(HTTP_STATUS.UNAUTHORIZED, `No credentials for STT provider: ${provider}`)
	}

	// Format-switch extension: an explicit caller marker wins over the registry
	// marker; with neither, the provider-default sttConfig.format applies.
	const marker =
		typeof transport === "string" && transport.trim()
			? transport.trim()
			: resolveModelTransport(provider, model)

	try {
		switch (marker || cfg.format) {
			case "gemini-live": {
				const live = await transcribeGeminiLive({
					cfg,
					file,
					model,
					token,
					formData,
					mimeType: resolveAudioContentType(file),
				})
				// response_format parity with the OpenAI-compatible transport: default
				// envelope stays {text}; verbose_json adds segments mapped from the
				// Live API's incremental inputTranscription deltas. Those frames carry
				// NO timestamps, so segments expose {id,text} only (id = delta order,
				// Whisper-compatible 0-based) - start/end/duration are deliberately
				// absent rather than fabricated as zeros, which would misrepresent
				// provider data to callers diffing transports.
				const fmt =
					typeof formData?.get === "function"
						? String(formData.get("response_format") ?? "")
								.trim()
								.toLowerCase()
						: ""
				if (fmt === "verbose_json") {
					return jsonResponse({
						text: live.text,
						segments: live.chunks.map((segText, id) => ({ id, text: segText })),
					})
				}
				return jsonResponse({ text: live.text })
			}
			case "deepgram":
				return await transcribeDeepgram(cfg, file, model, token, formData)
			case "assemblyai":
				return await transcribeAssemblyAI(cfg, file, model, token)
			case "nvidia-asr":
				return await transcribeNvidia(cfg, file, model, token)
			case "huggingface-asr":
				return await transcribeHuggingFace(cfg, file, model, token)
			case "gemini-stt":
				return await transcribeGemini(cfg, file, model, token, formData)
			case "elevenlabs-stt":
				return await transcribeElevenLabs(cfg, file, model, token, formData)
			default:
				return await transcribeOpenAICompatible(cfg, file, model, token, formData)
		}
	} catch (err) {
		return createErrorResult(
			err.status || HTTP_STATUS.BAD_GATEWAY,
			err.message || "STT request failed",
		)
	}
}
