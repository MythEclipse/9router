/**
 * TTS voice catalogues.
 *
 * Five routes answer the same question — "what can this provider say, grouped by language" —
 * and each one had grown its own copy of the same three steps: read the connection, call the
 * provider, group the payload. The differences are real (each provider names its id, its
 * languages and its failures differently) so each keeps its own shape function; what moves
 * here is the sequence around them, which was identical and drifting.
 *
 * Two failure rules are carried over deliberately, because both are easy to "fix" into a bug:
 *
 * - **A missing connection is a 400, not a 502.** Nothing upstream failed; the caller has not
 *   connected the provider yet. The dashboard renders it as an instruction to go connect.
 * - **MiniMax reports failure in the body with HTTP 200.** `base_resp.status_code` is the real
 *   verdict, so checking only `res.ok` hands the picker an empty list and no reason why.
 */

import { genericCatalogue, readKey } from "./tts-voice-catalogues.ts"
import {
	answer,
	LANGUAGE_NAMES,
	MINIMAX_VOICE_ENDPOINTS,
	normalizeMiniMaxVoices,
	upstreamFailed,
} from "./tts-voice-normalize.ts"
import type { TtsVoiceDeps, TtsVoiceQuery, TtsVoices, VoiceConnection } from "./tts-voice-types.ts"

export type { TtsVoiceDeps, TtsVoiceQuery, TtsVoices, VoiceConnection } from "./tts-voice-types.ts"

import { AppError } from "../../domain/errors.ts"
import {
	groupByListedLanguages,
	languageLabel,
	listedLanguages,
	sortedLanguages,
	spokenLanguages,
	type VoiceCatalogue,
	type VoiceLanguage,
	voiceId,
	voiceName,
} from "../../domain/voice-catalogue.ts"
import type {
	DeepgramTtsModel,
	ElevenLabsVoice,
	InworldVoice,
	MiniMaxVoicesPayload,
} from "./tts-voice-types.ts"

/** A connection as this layer needs it: an active provider's API key. */
export function makeTtsVoices(deps: TtsVoiceDeps): TtsVoices {
	const listing = async (query: TtsVoiceQuery) => {
		const provider = query.provider || "edge-tts"
		// An unknown provider is the caller's mistake, not an outage: name it, do not 502.
		if (!deps.providers.includes(provider)) {
			throw new AppError("VALIDATION", `Provider '${provider}' does not support voice listing`, {
				status: 400,
			})
		}

		const raw = await genericCatalogue(deps, provider, query.apiKey ?? "")
		const voices = query.lang ? raw.filter((v) => v.lang === query.lang) : raw

		const byLang: Record<string, VoiceLanguage> = {}
		for (const voice of voices) {
			const bucket = (byLang[voice.lang] ??= { code: voice.lang, name: voice.langName, voices: [] })
			bucket.voices.push(voice)
		}

		return { voices, languages: sortedLanguages(byLang), byLang }
	}

	const deepgram = async (query: { lang?: string }) => {
		const apiKey = await readKey(deps, "deepgram")
		const res = await deps.fetchImpl("https://api.deepgram.com/v1/models", {
			headers: { Authorization: `Token ${apiKey}` },
		})
		if (!res.ok) upstreamFailed("Deepgram", res.status, await res.text().catch(() => ""))
		const data = (await res.json()) as { tts?: DeepgramTtsModel[] }

		const catalogue = groupByListedLanguages(
			data.tts || [],
			// Deepgram sends `languages: ["en"]`, or only encodes it in the canonical_name suffix.
			(model) =>
				Array.isArray(model.languages) && model.languages.length
					? model.languages
					: [model.canonical_name?.split("-").pop() || "en"],
			(model, code) => {
				const id = voiceId([model.canonical_name, model.name])
				return {
					id,
					name: voiceName(model.name, id),
					gender: model.metadata?.tags?.find((tag) => tag === "masculine" || tag === "feminine") || "",
					lang: code,
				}
			},
			LANGUAGE_NAMES,
		)

		return answer(catalogue, query.lang)
	}

	const elevenlabs = async (query: { lang?: string }) => {
		// Direct store read, no auth mutex, so listing never blocks concurrent TTS inference.
		const apiKey = await readKey(deps, "elevenlabs")
		const voices = await deps.fetchElevenLabs(apiKey)

		const catalogue = groupByListedLanguages(
			voices,
			// A voice appears under every language it was verified for, not only its primary one:
			// the picker filters by language, and a bilingual voice would otherwise be unreachable
			// from one of the two lists.
			(voice) =>
				spokenLanguages(
					voice.labels?.language,
					(voice.verified_languages ?? []).map((entry) => entry.language ?? ""),
				),
			(voice, code) => ({
				id: voice.voice_id,
				name: voiceName(voice.name, voice.voice_id),
				gender: voice.labels?.gender || "",
				lang: code,
				// Premade voices are free; professional library voices may need a paid plan.
				free_users_allowed: voice.category === "premade" || voice.is_owner === true,
			}),
			LANGUAGE_NAMES,
		)

		return answer(catalogue, query.lang)
	}

	const inworld = async (query: { lang?: string }) => {
		const apiKey = await readKey(deps, "inworld")
		const res = await deps.fetchImpl("https://api.inworld.ai/tts/v1/voices", {
			headers: { Authorization: `Basic ${apiKey}` },
		})
		if (!res.ok) upstreamFailed("Inworld", res.status, await res.text().catch(() => ""))
		const data = (await res.json()) as { voices?: InworldVoice[] }

		const catalogue = groupByListedLanguages(
			data.voices || [],
			// Each voice carries `languages: ["en", "es", ...]`; a voice with none is still usable.
			(voice) => listedLanguages(voice.languages),
			(voice, code) => {
				const id = voiceId([voice.voiceId, voice.displayName])
				return {
					id,
					name: voiceName(voice.displayName, id),
					gender: voice.gender || "",
					lang: code,
				}
			},
			LANGUAGE_NAMES,
		)

		return answer(catalogue, query.lang)
	}

	const minimax = async (query: { provider?: string; voiceType?: string; lang?: string }) => {
		const provider = query.provider === "minimax-cn" ? "minimax-cn" : "minimax"
		const apiKey = await readKey(deps, provider)
		const res = await deps.fetchImpl(MINIMAX_VOICE_ENDPOINTS[provider], {
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify({ voice_type: query.voiceType || "all" }),
		})

		const rawText = await res.text()
		let data: Record<string, unknown> = {}
		if (rawText) {
			try {
				data = JSON.parse(rawText) as Record<string, unknown>
			} catch {
				data = {}
			}
		}

		const baseResp = (data.base_resp || data.baseResp || {}) as Record<string, unknown>
		const statusCode = Number(baseResp.status_code ?? baseResp.statusCode ?? 0)
		const statusMessage = String(baseResp.status_msg || baseResp.statusMsg || data.message || "")

		if (!res.ok) upstreamFailed("MiniMax", res.status, statusMessage || rawText)
		// MiniMax answers 200 with a failure inside `base_resp`; `res.ok` alone would hide it.
		if (statusCode !== 0) {
			throw new AppError("UPSTREAM", statusMessage || "MiniMax voice API error", { status: 502 })
		}

		return answer(normalizeMiniMaxVoices(data as MiniMaxVoicesPayload), query.lang)
	}

	return { listing, deepgram, elevenlabs, inworld, minimax }
}
