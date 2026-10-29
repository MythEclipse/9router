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

import { AppError } from "../../domain/errors.ts"
import {
	addVoice,
	CUSTOM_LANGUAGE_CODE,
	groupByListedLanguages,
	type languageBucket,
	languageLabel,
	listedLanguages,
	sortedLanguages,
	spokenLanguages,
	type VoiceCatalogue,
	type VoiceLanguage,
	voiceId,
	voiceName,
	voicesForLanguage,
} from "../../domain/voice-catalogue.ts"

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

/** An ElevenLabs voice, including the languages it was verified for. */
interface ElevenLabsVoice {
	voice_id: string
	name?: string
	category?: string
	is_owner?: boolean
	labels?: { gender?: string; language?: string }
	verified_languages?: { language?: string }[]
}

interface DeepgramTtsModel {
	canonical_name?: string
	name?: string
	languages?: string[]
	metadata?: { tags?: string[] }
}

interface InworldVoice {
	voiceId: string
	displayName?: string
	gender?: string
	languages?: string[]
}

interface MiniMaxVoiceItem {
	voice_id?: string
	voiceId?: string
	voice_name?: string
	voiceName?: string
}

interface MiniMaxVoicesPayload {
	[groupKey: string]: MiniMaxVoiceItem[] | undefined
}

/** The normalized voice shape returned to clients by the generic endpoint. */
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

/** A connection as this layer needs it: an active provider's API key. */
export interface VoiceConnection {
	apiKey?: string
}

export interface TtsVoiceDeps {
	/** The active connection for a provider, or none when the caller has not set one up. */
	readonly connectionOf: (provider: string) => Promise<VoiceConnection | undefined>
	/** Every provider's fetcher, keyed by the `?provider=` value the picker sends. */
	readonly fetchVoices: (
		provider: string,
		apiKey?: string,
	) => Promise<LocalDeviceVoice[] | ElevenShapeVoice[] | EdgeTtsVoice[]>
	/** ElevenLabs' fetcher, which needs the key as a positional argument. */
	readonly fetchElevenLabs: (apiKey: string) => Promise<ElevenLabsVoice[]>
	readonly fetchImpl: typeof fetch
	/** The providers the generic endpoint serves, so a typo is refused by name. */
	readonly providers: readonly string[]
}

export interface TtsVoiceQuery {
	/** Nothing means edge-tts, which needs no connection. */
	readonly provider?: string
	/** Keep only voices in this language code. */
	readonly lang?: string
	/** The generic endpoint takes the key from the query; the per-provider ones use the store. */
	readonly apiKey?: string
}

/** The three shapes of provider payload whose language/country live in different places. */
type RawVoices = LocalDeviceVoice[] | ElevenShapeVoice[] | EdgeTtsVoice[]

const MINIMAX_VOICE_ENDPOINTS: Record<string, string> = {
	minimax: "https://api.minimax.io/v1/get_voice",
	"minimax-cn": "https://api.minimaxi.com/v1/get_voice",
}

const MINIMAX_VOICE_GROUPS = [
	{ key: "system_voice", label: "System" },
	{ key: "voice_cloning", label: "Cloned" },
	{ key: "voice_generation", label: "Generated" },
	{ key: "music_generation", label: "Music" },
]

const REGION_NAMES = new Intl.DisplayNames(["en"], { type: "region" })
const LANGUAGE_NAMES = new Intl.DisplayNames(["en"], { type: "language" })

function regionName(code: string): string {
	try {
		return REGION_NAMES.of(code) ?? code
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
 * MiniMax encodes a system voice's language as the prefix of its id (`English_Graceful_Lady`).
 * Every other group — cloned, generated, music — has no language at all, so those voices go to
 * the `Custom` bucket rather than being guessed at.
 */
function inferLanguage(id: string): string {
	const value = typeof id === "string" ? id.trim() : ""
	if (!value.includes("_")) return CUSTOM_LANGUAGE_CODE
	return value.split("_")[0] || CUSTOM_LANGUAGE_CODE
}

function normalizeMiniMaxVoices(payload: MiniMaxVoicesPayload): VoiceCatalogue {
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
function answer(catalogue: VoiceCatalogue, langFilter?: string) {
	if (langFilter) return { voices: voicesForLanguage(catalogue.byLang, langFilter) }
	return catalogue
}

/** The upstream refused; 502 because the caller's request was fine. */
function upstreamFailed(label: string, status: number, detail: string): never {
	throw new AppError("UPSTREAM", `${label} API ${status}: ${detail || "Failed"}`, { status: 502 })
}

async function readKey(deps: TtsVoiceDeps, provider: string, fromQuery?: string): Promise<string> {
	// The generic endpoint takes the key from the query (the picker types it before saving);
	// the per-provider ones read the stored connection. Both end up at the same 400 when absent.
	const key = fromQuery || (await deps.connectionOf(provider))?.apiKey
	if (!key) throw new AppError("VALIDATION", `No ${provider} connection found`, { status: 400 })
	return key
}

/** Build the catalogue for one of the four providers the generic endpoint serves. */
async function genericCatalogue(
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

export interface TtsVoices {
	/** The generic endpoint: edge-tts, local-device, elevenlabs and gemini behind one query. */
	readonly listing: (query: TtsVoiceQuery) => Promise<unknown>
	readonly deepgram: (query: { lang?: string }) => Promise<unknown>
	readonly elevenlabs: (query: { lang?: string }) => Promise<unknown>
	readonly inworld: (query: { lang?: string }) => Promise<unknown>
	readonly minimax: (query: {
		provider?: string
		voiceType?: string
		lang?: string
	}) => Promise<unknown>
}

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
