import { Buffer } from "node:buffer"
import { PROVIDER_ID_TO_ALIAS, PROVIDER_MODELS } from "../config/providerModels.ts"
import { HTTP_STATUS } from "../config/runtimeConfig.ts"
import { createErrorResult } from "../utils/error.ts"
import { FormDataImpl as FormData } from "../utils/formDataCompat.ts"
import { transcribeCodex } from "./codexStt.ts"
import { transcribeGeminiLive } from "./geminiLiveStt.ts"

import { buildAuthHeaders, resolveAudioContentType, upstreamError } from "./sttCommon.ts"
import { jsonResponse } from "./sttFormats.ts"
export async function transcribeDeepgram(cfg, file, model, token, formData) {
	const url = new URL(cfg.baseUrl)
	url.searchParams.set("model", model)
	url.searchParams.set("smart_format", "true")
	url.searchParams.set("punctuate", "true")
	const lang = formData.get("language")
	if (typeof lang === "string" && lang.trim()) url.searchParams.set("language", lang.trim())
	else url.searchParams.set("detect_language", "true")

	const buf = await file.arrayBuffer()
	const res = await fetch(url, {
		method: "POST",
		headers: { ...buildAuthHeaders(cfg, token), "Content-Type": resolveAudioContentType(file) },
		body: buf,
	})
	if (!res.ok) return upstreamError(res)
	const data = await res.json()
	const text = data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? ""
	return jsonResponse({ text })
}

// AssemblyAI: upload → submit → poll (max 120s)
export async function transcribeAssemblyAI(cfg, file, model, token) {
	const auth = buildAuthHeaders(cfg, token)
	const buf = await file.arrayBuffer()
	const up = await fetch("https://api.assemblyai.com/v2/upload", {
		method: "POST",
		headers: { ...auth, "Content-Type": "application/octet-stream" },
		body: buf,
	})
	if (!up.ok) return upstreamError(up)
	const { upload_url } = await up.json()

	const sub = await fetch(cfg.baseUrl, {
		method: "POST",
		headers: { ...auth, "Content-Type": "application/json" },
		body: JSON.stringify({ audio_url: upload_url, speech_models: [model], language_detection: true }),
	})
	if (!sub.ok) return upstreamError(sub)
	const { id } = await sub.json()

	const start = Date.now()
	while (Date.now() - start < 120_000) {
		await new Promise((r) => setTimeout(r, 2000))
		const poll = await fetch(`${cfg.baseUrl}/${id}`, { headers: auth })
		if (!poll.ok) continue
		const r = await poll.json()
		if (r.status === "completed") return jsonResponse({ text: r.text || "" })
		if (r.status === "error") return createErrorResult(500, r.error || "AssemblyAI failed")
	}
	return createErrorResult(504, "AssemblyAI timeout after 120s")
}

// Nvidia NIM: multipart, normalize response
export async function transcribeNvidia(cfg, file, model, token) {
	const fd = new FormData()
	fd.append("file", file, file.name || "audio.wav")
	fd.append("model", model)
	const res = await fetch(cfg.baseUrl, {
		method: "POST",
		headers: buildAuthHeaders(cfg, token),
		body: fd,
	})
	if (!res.ok) return upstreamError(res)
	const data = await res.json()
	return jsonResponse({ text: data.text || data.transcript || "" })
}

// Gemini: generateContent with inline_data audio + transcription prompt
export async function transcribeGemini(cfg, file, model, token, formData) {
	const buf = await file.arrayBuffer()
	const b64 = Buffer.from(buf).toString("base64")
	const mime = resolveAudioContentType(file)
	const lang = formData.get("language")
	const userPrompt = formData.get("prompt")
	let promptText =
		userPrompt && typeof userPrompt === "string" && userPrompt.trim()
			? userPrompt.trim()
			: "Generate a transcript of the speech. Return only the transcribed text, no commentary."
	if (typeof lang === "string" && lang.trim()) promptText += ` Language: ${lang.trim()}.`

	const url = `${cfg.baseUrl}/${model}:generateContent?key=${token}`
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			contents: [{ parts: [{ text: promptText }, { inline_data: { mime_type: mime, data: b64 } }] }],
		}),
	})
	if (!res.ok) return upstreamError(res)
	const data = await res.json()
	const text =
		data?.candidates?.[0]?.content?.parts
			?.map((p) => p.text)
			.filter(Boolean)
			.join("") || ""
	return jsonResponse({ text })
}
