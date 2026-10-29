import {
	groupByListedLanguages,
	spokenLanguages,
	voiceName,
	voicesForLanguage,
} from "9router-api/domain/voice-catalogue"
import { NextResponse } from "next/server"
import { type ElevenLabsVoice, fetchElevenLabsVoices } from "open-sse/handlers/ttsCore"
import { getProviderConnections } from "@/lib/localDb"

export const dynamic = "force-dynamic"

const langNames = new Intl.DisplayNames(["en"], { type: "language" })

/**
 * GET /api/media-providers/tts/elevenlabs/voices[?lang=en]
 * Returns { languages, byLang } grouped by language - same format as the other TTS routes.
 * Uses direct DB read (no mutex) to avoid blocking on concurrent TTS requests.
 *
 * A voice appears under every language ElevenLabs verified it for, not only its primary one:
 * the picker filters by language, and a voice that speaks both English and Spanish would
 * otherwise be unreachable from one of the two lists.
 */
export async function GET(request) {
	try {
		const { searchParams } = new URL(request.url)
		const langFilter = searchParams.get("lang")

		// Direct DB read - bypass auth mutex used for TTS inference
		const connections = await getProviderConnections({ provider: "elevenlabs", isActive: true })
		const apiKey = String(connections[0]?.apiKey ?? "")
		if (!apiKey) {
			return NextResponse.json({ error: "No ElevenLabs connection found" }, { status: 400 })
		}

		const voices = await fetchElevenLabsVoices(apiKey)

		const catalogue = groupByListedLanguages(
			voices,
			(voice) =>
				spokenLanguages(
					voice.labels?.language,
					(voice.verified_languages ?? []).map((entry) => entry.language ?? ""),
				),
			(voice: ElevenLabsVoice, code) => ({
				id: voice.voice_id,
				name: voiceName(voice.name, voice.voice_id),
				gender: voice.labels?.gender || "",
				lang: code,
				// Premade voices are free; professional library voices added to an account may need a paid plan.
				free_users_allowed: voice.category === "premade" || voice.is_owner === true,
			}),
			langNames,
		)

		if (langFilter) {
			return NextResponse.json({ voices: voicesForLanguage(catalogue.byLang, langFilter) })
		}
		return NextResponse.json(catalogue)
	} catch (err) {
		return NextResponse.json(
			{ error: err instanceof Error ? err.message : "Failed to fetch voices" },
			{ status: 502 },
		)
	}
}
