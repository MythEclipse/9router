import {
	languageLabel,
	sortedLanguages,
	type VoiceLanguage,
} from "9router-api/domain/voice-catalogue"
import { NextResponse } from "next/server"
import { VOICE_FETCHERS } from "open-sse/handlers/ttsCore"

export const dynamic = "force-dynamic"

/** A voice as returned by the local-device (OS speech synth) fetcher. */
interface LocalDeviceVoice {
	id: string
	name: string
	locale: string
	lang: string
	country: string
	gender: string
}

/** A voice in the ElevenLabs/Gemini shape (`voice_id` + `labels`). */
interface ElevenShapeVoice {
	voice_id: string
	name?: string
	category?: string
	labels?: { gender?: string; language?: string }
}

/** A voice as returned by the edge-tts fetcher. */
interface EdgeTtsVoice {
	ShortName: string
	FriendlyName?: string
	Locale: string
	Gender: string
}

/** The normalized voice shape returned to clients. */
interface NormalizedVoice {
	id: string
	name: string
	locale: string
	lang: string
	country: string
	countryName: string
	langName: string
	gender: string
	category?: string
}

// Map locale code → country name
const LOCALE_NAMES = new Intl.DisplayNames(["en"], { type: "region" })
const LANG_NAMES = new Intl.DisplayNames(["en"], { type: "language" })

function regionName(code: string): string {
	try {
		return LOCALE_NAMES.of(code) ?? code
	} catch {
		return code
	}
}

/** `Microsoft X Online (Natural) - ...` → `X (...)`, dropping the vendor prefix and suffix. */
function edgeTtsName(voice: EdgeTtsVoice): string {
	return (voice.FriendlyName || voice.ShortName)
		.replace("Microsoft ", "")
		.replace(/ Online \(Natural\) - /g, " (")
}

/**
 * GET /api/media-providers/tts/voices
 * Query:
 *   ?provider=edge-tts | local-device | elevenlabs | gemini  (default: edge-tts)
 *   ?lang=en     (optional filter by lang code)
 *   ?apiKey=xxx  (required for elevenlabs)
 *
 * The three payload shapes differ in where the language and the country live, not in what the
 * picker needs, so each branch reshapes one entry and the grouping stays in the domain.
 */
export async function GET(request) {
	try {
		const { searchParams } = new URL(request.url)
		const provider = searchParams.get("provider") || "edge-tts"
		const langFilter = searchParams.get("lang")
		const apiKey = searchParams.get("apiKey")

		const fetcher = VOICE_FETCHERS[provider]
		if (!fetcher) {
			return NextResponse.json(
				{ error: `Provider '${provider}' does not support voice listing` },
				{ status: 400 },
			)
		}

		// ElevenLabs requires API key
		const raw = (provider === "elevenlabs" ? await fetcher(apiKey) : await fetcher()) as
			| LocalDeviceVoice[]
			| ElevenShapeVoice[]
			| EdgeTtsVoice[]
		const useElevenShape = provider === "elevenlabs" || provider === "gemini"
		let voices: NormalizedVoice[]

		if (provider === "local-device") {
			voices = (raw as LocalDeviceVoice[]).map((v) => ({
				id: v.id,
				name: v.name,
				locale: v.locale.replace("_", "-"),
				lang: v.lang,
				country: v.country,
				countryName: regionName(v.country),
				langName: languageLabel(v.lang, LANG_NAMES),
				gender: v.gender,
			}))
		} else if (useElevenShape) {
			voices = (raw as ElevenShapeVoice[]).map((v) => {
				const locale = v.labels?.language || "en"
				const lang = locale.split("-")[0]
				return {
					id: v.voice_id,
					name: v.name ?? v.voice_id,
					locale,
					lang,
					country: "",
					countryName: "",
					langName: languageLabel(lang, LANG_NAMES),
					gender: v.labels?.gender || "",
					category: v.category,
				}
			})
		} else {
			// edge-tts (default)
			voices = (raw as EdgeTtsVoice[]).map((v) => {
				const [lang, country] = v.Locale.split("-")
				return {
					id: v.ShortName,
					name: edgeTtsName(v),
					locale: v.Locale,
					lang,
					country: country || "",
					countryName: regionName(country || lang),
					langName: languageLabel(lang, LANG_NAMES),
					gender: v.Gender,
				}
			})
		}

		// Apply filter
		if (langFilter) voices = voices.filter((v) => v.lang === langFilter)

		const byLang: Record<string, VoiceLanguage> = {}
		for (const voice of voices) {
			const bucket = (byLang[voice.lang] ??= {
				code: voice.lang,
				name: voice.langName,
				voices: [],
			})
			bucket.voices.push(voice)
		}

		return NextResponse.json({ voices, languages: sortedLanguages(byLang), byLang })
	} catch (err) {
		return NextResponse.json(
			{ error: err instanceof Error ? err.message : "Failed to fetch voices" },
			{ status: 502 },
		)
	}
}
