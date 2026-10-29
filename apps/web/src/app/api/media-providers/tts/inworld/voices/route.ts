import {
	groupByListedLanguages,
	listedLanguages,
	voiceId,
	voiceName,
	voicesForLanguage,
} from "9router-api/domain/voice-catalogue"
import { NextResponse } from "next/server"
import { getProviderConnections } from "@/lib/localDb"

export const dynamic = "force-dynamic"

const langNames = new Intl.DisplayNames(["en"], { type: "language" })

interface InworldVoice {
	voiceId: string
	displayName?: string
	gender?: string
	languages?: string[]
}

interface InworldVoicesResponse {
	voices?: InworldVoice[]
}

/**
 * GET /api/media-providers/tts/inworld/voices[?lang=en]
 * Returns { languages, byLang } grouped by language code (same shape as the other TTS routes).
 */
export async function GET(request) {
	try {
		const { searchParams } = new URL(request.url)
		const langFilter = searchParams.get("lang")

		const connections = await getProviderConnections({ provider: "inworld", isActive: true })
		const apiKey = connections[0]?.apiKey
		if (!apiKey) return NextResponse.json({ error: "No Inworld connection found" }, { status: 400 })

		const res = await fetch("https://api.inworld.ai/tts/v1/voices", {
			headers: { Authorization: `Basic ${apiKey}` },
		})
		if (!res.ok) {
			const text = await res.text().catch(() => "")
			return NextResponse.json(
				{ error: `Inworld API ${res.status}: ${text || "Failed"}` },
				{ status: 502 },
			)
		}
		const data = (await res.json()) as InworldVoicesResponse

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
			langNames,
		)

		if (langFilter) {
			return NextResponse.json({ voices: voicesForLanguage(catalogue.byLang, langFilter) })
		}
		return NextResponse.json(catalogue)
	} catch (err) {
		return NextResponse.json({ error: err.message || "Failed to fetch voices" }, { status: 502 })
	}
}
