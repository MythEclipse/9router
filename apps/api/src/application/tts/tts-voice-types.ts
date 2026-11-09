/** TTS voices: shared types. */
/** A voice as returned by the local-device (OS speech synth) fetcher. */
export interface LocalDeviceVoice {
	id: string
	name: string
	locale: string
	lang: string
	country: string
	gender: string
}

/** A voice in the ElevenLabs/Gemini shape (`voice_id` + `labels`). */
export interface ElevenShapeVoice {
	voice_id: string
	name?: string
	category?: string
	labels?: { gender?: string; language?: string }
}

/** A voice as returned by the edge-tts fetcher. */
export interface EdgeTtsVoice {
	ShortName: string
	FriendlyName?: string
	Locale: string
	Gender: string
}

/** An ElevenLabs voice, including the languages it was verified for. */
export interface ElevenLabsVoice {
	voice_id: string
	name?: string
	category?: string
	is_owner?: boolean
	labels?: { gender?: string; language?: string }
	verified_languages?: { language?: string }[]
}

export interface DeepgramTtsModel {
	canonical_name?: string
	name?: string
	languages?: string[]
	metadata?: { tags?: string[] }
}

export interface InworldVoice {
	voiceId: string
	displayName?: string
	gender?: string
	languages?: string[]
}

export interface MiniMaxVoiceItem {
	voice_id?: string
	voiceId?: string
	voice_name?: string
	voiceName?: string
}

export interface MiniMaxVoicesPayload {
	[groupKey: string]: MiniMaxVoiceItem[] | undefined
}

/** The normalized voice shape returned to clients by the generic endpoint. */
export interface NormalizedVoice {
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
export type RawVoices = LocalDeviceVoice[] | ElevenShapeVoice[] | EdgeTtsVoice[]

export interface TtsVoices {
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
