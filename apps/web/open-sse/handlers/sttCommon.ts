import { Buffer } from "node:buffer"
import { PROVIDER_ID_TO_ALIAS, PROVIDER_MODELS } from "../config/providerModels.ts"
import { HTTP_STATUS } from "../config/runtimeConfig.ts"
import { createErrorResult } from "../utils/error.ts"
import { transcribeCodex } from "./codexStt.ts"
import { transcribeGeminiLive } from "./geminiLiveStt.ts"

// Build auth headers from sttConfig + token
export function buildAuthHeaders(cfg, token) {
	if (!token) return {}
	switch (cfg.authHeader) {
		case "bearer":
			return { Authorization: `Bearer ${token}` }
		case "token":
			return { Authorization: `Token ${token}` }
		case "x-api-key":
			return { "x-api-key": token }
		case "xi-api-key":
			return { "xi-api-key": token }
		case "key":
			return { Authorization: `Key ${token}` }
		default:
			return { Authorization: `Bearer ${token}` }
	}
}

// Map browser file MIME / ext → audio MIME for binary formats (deepgram/HF)
export function resolveAudioContentType(file) {
	const t = (file.type || "").toLowerCase()
	if (t.startsWith("audio/")) return t
	const name = typeof file.name === "string" ? file.name.toLowerCase() : ""
	const ext = name.includes(".") ? name.split(".").pop() : ""
	const map = {
		mp3: "audio/mpeg",
		mp4: "audio/mp4",
		m4a: "audio/mp4",
		wav: "audio/wav",
		ogg: "audio/ogg",
		flac: "audio/flac",
		webm: "audio/webm",
		aac: "audio/aac",
		opus: "audio/opus",
	}
	return map[ext] || "application/octet-stream"
}

export async function upstreamError(res) {
	let txt = ""
	try {
		txt = await res.text()
	} catch {}
	let msg = txt || `Upstream error (${res.status})`
	try {
		const j = JSON.parse(txt)
		msg = j?.error?.message || j?.error || j?.message || msg
	} catch {}
	return createErrorResult(res.status, typeof msg === "string" ? msg : JSON.stringify(msg))
}

// Deepgram: raw binary POST + model query param
