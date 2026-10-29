import {
	addVoice,
	CUSTOM_LANGUAGE_CODE,
	type languageBucket,
	sortedLanguages,
	type VoiceCatalogue,
	voiceId,
	voiceName,
	voicesForLanguage,
} from "9router-api/domain/voice-catalogue"
import { NextResponse } from "next/server"
import { getProviderConnections } from "@/lib/localDb"

export const dynamic = "force-dynamic"

const MINIMAX_VOICE_ENDPOINTS = {
	minimax: "https://api.minimax.io/v1/get_voice",
	"minimax-cn": "https://api.minimaxi.com/v1/get_voice",
}

const VOICE_GROUPS = [
	{ key: "system_voice", label: "System" },
	{ key: "voice_cloning", label: "Cloned" },
	{ key: "voice_generation", label: "Generated" },
	{ key: "music_generation", label: "Music" },
]

/**
 * MiniMax encodes a system voice's language as the prefix of its id (`English_Graceful_Lady`).
 * Every other group — cloned, generated, music — has no language at all, so those voices go to
 * the `Custom` bucket rather than being guessed at.
 */
function inferLanguage(voiceId: string): string {
	const value = typeof voiceId === "string" ? voiceId.trim() : ""
	if (!value.includes("_")) return CUSTOM_LANGUAGE_CODE
	return value.split("_")[0] || CUSTOM_LANGUAGE_CODE
}

/** One MiniMax voice group as returned under a VOICE_GROUPS key. */
interface MiniMaxVoiceItem {
	voice_id?: string
	voiceId?: string
	voice_name?: string
	voiceName?: string
}

/** Shape of the MiniMax `/v1/get_voice` payload. */
interface MiniMaxVoicesPayload {
	[groupKey: string]: MiniMaxVoiceItem[] | undefined
}

function normalizeMiniMaxVoices(payload: MiniMaxVoicesPayload): VoiceCatalogue {
	const byLang: Record<string, ReturnType<typeof languageBucket>> = {}
	const displayNames = new Intl.DisplayNames(["en"], { type: "language" })

	for (const group of VOICE_GROUPS) {
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
				displayNames,
			)
		}
	}

	const languages = sortedLanguages(byLang)
	for (const language of languages) {
		language.voices.sort((left, right) => left.name.localeCompare(right.name))
	}

	return { languages, byLang }
}

/**
 * GET /api/media-providers/tts/minimax/voices[?provider=minimax|minimax-cn&voice_type=all]
 * Returns { languages, byLang } grouped for the shared TTS voice picker.
 *
 * MiniMax reports its own failures in the body with HTTP 200, so `base_resp.status_code` is the
 * real verdict — checking only `res.ok` would hand the picker an empty list and no reason why.
 */
export async function GET(request) {
	try {
		const { searchParams } = new URL(request.url)
		const provider = searchParams.get("provider") === "minimax-cn" ? "minimax-cn" : "minimax"
		const voiceType = searchParams.get("voice_type") || "all"
		const langFilter = searchParams.get("lang")

		const connections = await getProviderConnections({ provider, isActive: true })
		const apiKey = connections[0]?.apiKey
		if (!apiKey) {
			return NextResponse.json({ error: `No ${provider} connection found` }, { status: 400 })
		}

		const res = await fetch(MINIMAX_VOICE_ENDPOINTS[provider], {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ voice_type: voiceType }),
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
		const statusMessage = baseResp.status_msg || baseResp.statusMsg || data.message || ""

		if (!res.ok) {
			return NextResponse.json(
				{ error: `MiniMax API ${res.status}: ${statusMessage || rawText || "Failed"}` },
				{ status: 502 },
			)
		}
		if (statusCode !== 0) {
			return NextResponse.json({ error: statusMessage || "MiniMax voice API error" }, { status: 502 })
		}

		const catalogue = normalizeMiniMaxVoices(data as MiniMaxVoicesPayload)
		if (langFilter) {
			return NextResponse.json({ voices: voicesForLanguage(catalogue.byLang, langFilter) })
		}

		return NextResponse.json(catalogue)
	} catch (err) {
		return NextResponse.json(
			{ error: err.message || "Failed to fetch MiniMax voices" },
			{ status: 502 },
		)
	}
}
