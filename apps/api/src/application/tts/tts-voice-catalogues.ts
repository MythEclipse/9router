/** TTS voices: generic catalogue builders. */
import { AppError } from "../../domain/errors.ts"
import { languageLabel, type VoiceCatalogue } from "../../domain/voice-catalogue.ts"
import {
	answer,
	edgeTtsName,
	LANGUAGE_NAMES,
	regionName,
	upstreamFailed,
} from "./tts-voice-normalize.ts"
import type {
	EdgeTtsVoice,
	ElevenShapeVoice,
	LocalDeviceVoice,
	NormalizedVoice,
	RawVoices,
	TtsVoiceDeps,
} from "./tts-voice-types.ts"

export async function readKey(
	deps: TtsVoiceDeps,
	provider: string,
	fromQuery?: string,
): Promise<string> {
	// The generic endpoint takes the key from the query (the picker types it before saving);
	// the per-provider ones read the stored connection. Both end up at the same 400 when absent.
	const key = fromQuery || (await deps.connectionOf(provider))?.apiKey
	if (!key) throw new AppError("VALIDATION", `No ${provider} connection found`, { status: 400 })
	return key
}

/** Build the catalogue for one of the four providers the generic endpoint serves. */
export async function genericCatalogue(
	deps: TtsVoiceDeps,
	provider: string,
	apiKey: string,
): Promise<NormalizedVoice[]> {
	// ElevenLabs takes its key positionally; every other fetcher takes none.
	const raw = (
		provider === "elevenlabs"
			? await deps.fetchVoices(provider, apiKey)
			: await deps.fetchVoices(provider)
	) as RawVoices
	const useElevenShape = provider === "elevenlabs" || provider === "gemini"

	if (provider === "local-device") {
		return (raw as LocalDeviceVoice[]).map((v) => ({
			id: v.id,
			name: v.name,
			locale: v.locale.replace("_", "-"),
			lang: v.lang,
			country: v.country,
			countryName: regionName(v.country),
			langName: languageLabel(v.lang, LANGUAGE_NAMES),
			gender: v.gender,
		}))
	}

	if (useElevenShape) {
		return (raw as ElevenShapeVoice[]).map((v) => {
			const locale = v.labels?.language || "en"
			const lang = locale.split("-")[0]
			return {
				id: v.voice_id,
				name: v.name ?? v.voice_id,
				locale,
				lang,
				country: "",
				countryName: "",
				langName: languageLabel(lang, LANGUAGE_NAMES),
				gender: v.labels?.gender || "",
				category: v.category,
			}
		})
	}

	return (raw as EdgeTtsVoice[]).map((v) => {
		const [lang, country] = v.Locale.split("-")
		return {
			id: v.ShortName,
			name: edgeTtsName(v),
			locale: v.Locale,
			lang,
			country: country || "",
			countryName: regionName(country || lang),
			langName: languageLabel(lang, LANGUAGE_NAMES),
			gender: v.Gender,
		}
	})
}
