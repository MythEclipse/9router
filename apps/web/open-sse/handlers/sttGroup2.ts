import { Buffer } from "node:buffer"
import { PROVIDER_ID_TO_ALIAS, PROVIDER_MODELS } from "../config/providerModels.ts"
import { HTTP_STATUS } from "../config/runtimeConfig.ts"
import { createErrorResult } from "../utils/error.ts"
import { FormDataImpl as FormData } from "../utils/formDataCompat.ts"
import { transcribeCodex } from "./codexStt.ts"
import { transcribeGeminiLive } from "./geminiLiveStt.ts"

import { buildAuthHeaders, resolveAudioContentType, upstreamError } from "./sttCommon.ts"
import { jsonResponse, textResponse } from "./sttFormats.ts"
// ElevenLabs Scribe: multipart POST /v1/speech-to-text (xi-api-key).
// Optional renderings (srt/vtt/seg_json) come back as `additional_formats`; the
// requested one is served verbatim instead of being fabricated from the JSON body.
export async function transcribeElevenLabs(cfg, file, model, token, formData) {
	const fd = new FormData()
	fd.append("file", file, file.name || "audio.wav")
	fd.append("model_id", model)

	const get = (k) => {
		const v = formData?.get?.(k)
		return typeof v === "string" ? v.trim() : ""
	}
	// Blank language_code → upstream auto-detect, so the field is omitted entirely.
	const language = get("language")
	if (language) fd.append("language_code", language)

	const granularity = get("timestamps_granularity")
	if (["word", "character", "none"].includes(granularity)) {
		fd.append("timestamps_granularity", granularity)
	}
	if (get("tag_audio_events") === "true") fd.append("tag_audio_events", "true")

	// diarize and num_speakers are mutually exclusive upstream; diarize wins when both
	// are sent so the request stays valid instead of erroring.
	const numSpeakers = get("num_speakers")
	const num = Number(numSpeakers)
	if (get("diarize") === "true") {
		fd.append("diarize", "true")
	} else if (Number.isInteger(num) && num >= 1 && num <= 32) {
		fd.append("num_speakers", String(num))
	}

	const fmt = get("response_format").toLowerCase() || "json"
	const formats = cfg.responseFormats || {}
	// subtitle/caption formats are returned as raw text, not a JSON envelope
	const rawFormat = { srt: formats.subtitles, vtt: formats.captions }[fmt]
	const extraFormat = rawFormat || (fmt === "verbose_json" ? formats.segments : null)
	if (extraFormat) {
		fd.append("additional_formats", JSON.stringify([{ format: extraFormat }]))
	}

	const res = await fetch(cfg.baseUrl, {
		method: "POST",
		headers: buildAuthHeaders(cfg, token),
		body: fd,
	})
	if (!res.ok) return upstreamError(res)

	const data = await res.json()
	const text = typeof data?.text === "string" ? data.text : ""
	const segments = extractAdditionalFormat(data, extraFormat)

	if (rawFormat) return textResponse(segments ?? text)
	if (fmt === "verbose_json") {
		return jsonResponse({
			text,
			language: data?.language_code ?? null,
			...(data?.language_probability != null
				? { language_probability: data.language_probability }
				: {}),
			...(Array.isArray(data?.words) ? { words: data.words } : {}),
			...(data?.num_speakers != null ? { num_speakers: data.num_speakers } : {}),
			// Real segments only when the upstream render was requested — never
			// synthesized, so transports diffed by clients don't show invented timings.
			...(segments ? { segments } : {}),
		})
	}
	if (fmt === "text") return textResponse(text)
	return jsonResponse({ text })
}

// ElevenLabs returns `additional_formats[].content` as a plain string (srt/vtt) or
// as a JSON *string* holding the segment render (seg_json). Returns null when the
// render is absent or unparseable so callers can fall back rather than guess.
export function extractAdditionalFormat(data, format) {
	if (!format || !Array.isArray(data?.additional_formats)) return null
	const content = data.additional_formats.find((f) => f?.format === format)?.content
	if (typeof content !== "string") return null
	if (format !== "seg_json") return content
	try {
		return JSON.parse(content)
	} catch {
		return null
	}
}
