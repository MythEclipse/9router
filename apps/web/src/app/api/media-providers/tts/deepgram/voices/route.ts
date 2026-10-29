import {
	groupByListedLanguages,
	voiceId,
	voiceName,
	voicesForLanguage,
} from "9router-api/domain/voice-catalogue"
import { NextResponse } from "next/server"
import { getProviderConnections } from "@/lib/localDb"

export const dynamic = "force-dynamic"

interface DeepgramTtsModel {
	canonical_name?: string
	name?: string
	languages?: string[]
	metadata?: { tags?: string[] }
}

interface DeepgramModelsResponse {
	tts?: DeepgramTtsModel[]
}

const langNames = new Intl.DisplayNames(["en"], { type: "language" })

/**
 * GET /api/media-providers/tts/deepgram/voices[?lang=en]
 * Returns { languages, byLang } grouped by language code (same shape as the other TTS routes).
 * Each Deepgram TTS voice is one model (canonical_name like "aura-2-thalia-en").
 */
export async function GET(request) {
	try {
		const { searchParams } = new URL(request.url)
		const langFilter = searchParams.get("lang")

		const connections = await getProviderConnections({ provider: "deepgram", isActive: true })
		const apiKey = connections[0]?.apiKey
		if (!apiKey) return NextResponse.json({ error: "No Deepgram connection found" }, { status: 400 })

		const res = await fetch("https://api.deepgram.com/v1/models", {
			headers: { Authorization: `Token ${apiKey}` },
		})
		if (!res.ok) {
			const text = await res.text().catch(() => "")
			return NextResponse.json(
				{ error: `Deepgram API ${res.status}: ${text || "Failed"}` },
				{ status: 502 },
			)
		}
		const data = (await res.json()) as DeepgramModelsResponse

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
