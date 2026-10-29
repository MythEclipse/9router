/**
 * The voice picker asks five providers the same question and gets five different answers back.
 *
 * The picker itself is shared, so every answer has to arrive in one shape:
 * `{ languages, byLang }` — a sorted list of language buckets, each holding its voices. Five
 * routes were producing that shape with five slightly different opinions about what a language
 * bucket is, what a missing voice name falls back to, and when a voice belongs to *two* languages.
 * The differences were not intentional; they were the cost of writing the same grouping four times.
 *
 * What is worth naming here:
 *
 * - **A voice can belong to several languages, or none the provider admits to.** ElevenLabs lists
 *   one primary language in `labels.language` and any number in `verified_languages`. A voice that
 *   works in Spanish and English must appear under both, or the picker hides a voice that would
 *   have worked. Deepgram and Inworld list `languages[]` directly and need the same expansion.
 * - **A missing language name is not an error.** `Intl.DisplayNames` throws on anything it does not
 *   recognise — provider codes like `multi` or a bare `Custom` bucket. The bucket still has to
 *   render, so the code stands in as its own name.
 * - **One voice, one row per bucket.** Grouping by language is a many-to-many join written as a
 *   loop, and providers do sometimes repeat a voice inside a single language. Pushing blindly
 *   duplicates it in the picker.
 * - **`Custom` sorts last.** MiniMax's cloned and generated voices have no language, and dumping
 *   them at the top of the list buries every real language behind them.
 *
 * The directory name (`lang`) and its country (`country`) are separate because the picker shows
 * them separately: `en` is what `/v1/audio/speech` takes, `US` is only what the badge reads.
 */

/** One voice as the picker renders it. Optional fields are provider-specific. */
export interface VoiceEntry {
	readonly id: string
	readonly name: string
	readonly lang: string
	readonly gender: string
	readonly category?: string
	readonly free_users_allowed?: boolean
}

/** A language bucket: everything the picker needs to draw one expandable heading. */
export interface VoiceLanguage {
	readonly code: string
	readonly name: string
	readonly voices: VoiceEntry[]
}

/** The shape every voices route answers with. */
export interface VoiceCatalogue {
	readonly languages: VoiceLanguage[]
	readonly byLang: Record<string, VoiceLanguage>
}

/**
 * The bucket used for voices whose provider does not say which language they speak.
 *
 * Spelled as a code, not a language tag — see `languageLabel`, where `Intl` would otherwise
 * relabel it `custom` in lowercase and the picker would show a bucket named after a casing accident.
 */
export const CUSTOM_LANGUAGE_CODE = "Custom"

/**
 * The display name of a language, or the code when `Intl` does not know it.
 *
 * Two ways this can go wrong, and both cost the operator the whole language list over one entry:
 * `Intl.DisplayNames` throws on codes it does not recognise (`multi`, some provider codes), and it
 * *does* recognise `Custom` as a language tag and answers `custom`. Our own sentinel is not a
 * language, so it keeps its spelling.
 */
export function languageLabel(code: string, displayNames: Intl.DisplayNames): string {
	if (code === CUSTOM_LANGUAGE_CODE) return CUSTOM_LANGUAGE_CODE
	try {
		const label = displayNames.of(code)
		return label === undefined ? code : label
	} catch {
		return code
	}
}

/**
 * A name that is a string, or the fallback.
 *
 * Provider payloads carry `undefined`, `null`, and empty strings for the same thing, and an empty
 * name renders as a blank button the operator cannot identify.
 */
export function voiceName(candidate: unknown, fallback: string): string {
	return typeof candidate === "string" && candidate.trim() !== "" ? candidate : fallback
}

/** A language bucket, created on first use. */
export function languageBucket(code: string, displayNames: Intl.DisplayNames): VoiceLanguage {
	return { code, name: languageLabel(code, displayNames), voices: [] }
}

/**
 * Add a voice to a language bucket, ignoring a repeat.
 *
 * Providers repeat a voice inside one language often enough that this is load-bearing; a
 * duplicate renders as two identical buttons and the picker selects only one of them.
 */
export function addVoice(
	byLang: Record<string, VoiceLanguage>,
	code: string,
	voice: VoiceEntry,
	displayNames: Intl.DisplayNames,
): void {
	byLang[code] ??= languageBucket(code, displayNames)
	const bucket = byLang[code]
	if (bucket.voices.some((existing) => existing.id === voice.id)) return
	bucket.voices.push(voice)
}

/**
 * The language buckets as a sorted list, `Custom` last.
 *
 * `Custom` is not a language — it is the absence of one — so it belongs after every real answer
 * rather than sorted among them by a name that is not a name.
 */
export function sortedLanguages(byLang: Record<string, VoiceLanguage>): VoiceLanguage[] {
	return Object.values(byLang).sort((left, right) => {
		if (left.code === CUSTOM_LANGUAGE_CODE) return 1
		if (right.code === CUSTOM_LANGUAGE_CODE) return -1
		return left.name.localeCompare(right.name)
	})
}

/** Voices for one language, in the shape a `?lang=` request answers with. */
export function voicesForLanguage(
	byLang: Record<string, VoiceLanguage>,
	code: string | null,
): VoiceEntry[] {
	if (code === null) return []
	return byLang[code]?.voices ?? []
}

/**
 * The language codes a provider says a voice speaks, primary first, without repeats.
 *
 * The primary language is `labels.language` for ElevenLabs and the first entry of `languages[]`
 * for Deepgram and Inworld; both arrive here already normalised into a list.
 */
export function spokenLanguages(
	primary: string | undefined,
	verified: readonly string[],
): string[] {
	const primaryCode = voiceName(primary, "en")
	const codes = [primaryCode]
	for (const code of verified) {
		if (code !== "" && code !== primaryCode) codes.push(code)
	}
	return codes
}

/**
 * One voice bucket per language the provider lists, or `["en"]` when it lists none.
 *
 * A provider that answers with no languages at all still returned a usable voice; dropping it
 * would hide it from every language filter.
 */
export function listedLanguages(languages: unknown): string[] {
	if (!Array.isArray(languages)) return ["en"]
	const codes = languages.filter((code): code is string => typeof code === "string" && code !== "")
	return codes.length > 0 ? codes : ["en"]
}

/** A voice's id: the provider's canonical field, falling back to its display name. */
export function voiceId(candidates: ReadonlyArray<unknown>): string {
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.trim() !== "") return candidate
	}
	return ""
}

/**
 * Group voices that answer with an id and a list of languages.
 *
 * Deepgram and Inworld return the same structure under different field names, so the mapping from
 * one voice to an entry is the only part each route supplies.
 */
export function groupByListedLanguages<T>(
	voices: readonly T[],
	languagesOf: (voice: T) => string[],
	entryOf: (voice: T, code: string) => VoiceEntry,
	displayNames: Intl.DisplayNames,
): VoiceCatalogue {
	const byLang: Record<string, VoiceLanguage> = {}
	for (const voice of voices) {
		for (const code of languagesOf(voice)) {
			addVoice(byLang, code, entryOf(voice, code), displayNames)
		}
	}
	return { languages: sortedLanguages(byLang), byLang }
}
