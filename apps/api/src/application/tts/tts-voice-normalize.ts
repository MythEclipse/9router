/** TTS voices: normalisation helpers. */
import { AppError } from "../../domain/errors.ts"
import {
	addVoice,
	CUSTOM_LANGUAGE_CODE,
	type languageBucket,
	languageLabel,
	sortedLanguages,
	type VoiceCatalogue,
	voiceId,
	voiceName,
	voicesForLanguage,
} from "../../domain/voice-catalogue.ts"
import type { EdgeTtsVoice, MiniMaxVoicesPayload } from "./tts-voice-types.ts"

export const MINIMAX_VOICE_ENDPOINTS: Record<string, string> = {
	minimax: "https://api.minimax.io/v1/get_voice",
	"minimax-cn": "https://api.minimaxi.com/v1/get_voice",
}

export const MINIMAX_VOICE_GROUPS = [
	{ key: "system_voice", label: "System" },
	{ key: "voice_cloning", label: "Cloned" },
	{ key: "voice_generation", label: "Generated" },
	{ key: "music_generation", label: "Music" },
]

export const REGION_NAMES = new Intl.DisplayNames(["en"], { type: "region" })
export const LANGUAGE_NAMES = new Intl.DisplayNames(["en"], { type: "language" })

export function regionName(code: string): string {
	try {
		return REGION_NAMES.of(code) ?? code
	} catch {
		return code
	}
}

/** `Microsoft X Online (Natural) - ...` → `X (...)`, dropping the vendor prefix and suffix. */
export function edgeTtsName(voice: EdgeTtsVoice): string {
	return (voice.FriendlyName || voice.ShortName)
		.replace("Microsoft ", "")
		.replace(/ Online \(Natural\) - /g, " (")
}

/**
 * MiniMax encodes a system voice's language as the prefix of its id (`English_Graceful_Lady`).
 * Every other group — cloned, generated, music — has no language at all, so those voices go to
 * the `Custom` bucket rather than being guessed at.
 */
export function inferLanguage(id: string): string {
	const value = typeof id === "string" ? id.trim() : ""
	if (!value.includes("_")) return CUSTOM_LANGUAGE_CODE
	return value.split("_")[0] || CUSTOM_LANGUAGE_CODE
}

export function normalizeMiniMaxVoices(payload: MiniMaxVoicesPayload): VoiceCatalogue {
	const byLang: Record<string, ReturnType<typeof languageBucket>> = {}

	for (const group of MINIMAX_VOICE_GROUPS) {
		const voices = Array.isArray(payload?.[group.key]) ? payload[group.key] : []
		for (const item of voices ?? []) {
			const id = voiceId([item?.voice_id, item?.voiceId])
			// A group entry with no id is not a voice; there is nothing to select.
			if (id === "") continue

			const name = voiceName(item?.voice_name ?? item?.voiceName, id)
			const lang = group.key === "system_voice" ? inferLanguage(id) : CUSTOM_LANGUAGE_CODE
			addVoice(
				byLang,
				lang,
				{
					id,
					// Only system voices carry their own name; the rest need the group, because
					// cloned and generated voices are often named after the same person.
					name: group.key === "system_voice" ? name : `${name} · ${group.label}`,
					lang,
					gender: "",
					category: group.key,
				},
				LANGUAGE_NAMES,
			)
		}
	}

	const languages = sortedLanguages(byLang)
	for (const language of languages) {
		language.voices.sort((left, right) => left.name.localeCompare(right.name))
	}

	return { languages, byLang }
}

/** Group by language and answer either the whole catalogue or one language's voices. */
export function answer(catalogue: VoiceCatalogue, langFilter?: string) {
	if (langFilter) return { voices: voicesForLanguage(catalogue.byLang, langFilter) }
	return catalogue
}

/** The upstream refused; 502 because the caller's request was fine. */
export function upstreamFailed(label: string, status: number, detail: string): never {
	throw new AppError("UPSTREAM", `${label} API ${status}: ${detail || "Failed"}`, { status: 502 })
}
