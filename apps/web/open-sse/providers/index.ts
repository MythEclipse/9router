// Single source: build PROVIDERS + PROVIDER_MODELS from registry/{id}.ts (transport + models co-located).

import { buildTtsProviderModels } from "../config/ttsModels.ts"
import { normalizeModel } from "./models/schema.ts"
import REGISTRY from "./registry/index.ts"
import type {
	MediaConfig,
	OAuthConfig,
	ProviderMediaRegistry,
	ProviderModelRegistry,
	ProviderOAuthRegistry,
	ProviderRegistry,
	RegistryEntry,
	TransportConfig,
} from "./schema.ts"
import { PROVIDER_DEFAULTS } from "./schema.ts"

// oauth block is canonical for these fields; inject into transport so executors reading
// this.config.{clientId,clientSecret,tokenUrl} keep working without duplicating in transport
const OAUTH_INJECT_FIELDS = ["clientId", "clientSecret", "tokenUrl"] as const

// transport: re-apply shared default (format:"openai") + inject oauth-canonical fields
function buildTransport(transport: TransportConfig, oauth?: OAuthConfig): TransportConfig {
	const t: TransportConfig = { ...transport }
	if (!t.format) t.format = PROVIDER_DEFAULTS.format
	if (oauth) {
		for (const f of OAUTH_INJECT_FIELDS) {
			if (t[f] === undefined && oauth[f] !== undefined) (t as Record<string, unknown>)[f] = oauth[f]
		}
	}
	return t
}

const MEDIA_KEYS: string[] = [
	"serviceKinds",
	"ttsConfig",
	"sttConfig",
	"embeddingConfig",
	"imageConfig",
	"imageToTextConfig",
	"videoConfig",
	"musicConfig",
	"searchViaChat",
	"searchConfig",
	"fetchConfig",
	"systemoneConfig",
	"modelsFetcher",
	"mediaPriority",
	"hiddenKinds",
]

export const PROVIDERS: ProviderRegistry = {}
export const PROVIDER_MODELS: ProviderModelRegistry = {}
export const PROVIDER_OAUTH: ProviderOAuthRegistry = {}
export const PROVIDER_MEDIA: ProviderMediaRegistry = {}
for (const entry of REGISTRY as RegistryEntry[]) {
	if (entry.transport) {
		PROVIDERS[entry.id] = buildTransport(entry.transport, entry.oauth)
		if (entry.transports) PROVIDERS[entry.id].transports = entry.transports
	}
	if (entry.models !== undefined) {
		PROVIDER_MODELS[entry.alias || entry.id] = entry.models.map(normalizeModel)
	}
	if (entry.oauth) PROVIDER_OAUTH[entry.id] = entry.oauth
	// Build PROVIDER_MEDIA from top-level fields (post-migration) + legacy entry.media
	const mediaFields: Record<string, unknown> = {}
	for (const k of MEDIA_KEYS) {
		if (entry[k] !== undefined) mediaFields[k] = entry[k]
	}
	if (entry.media) Object.assign(mediaFields, entry.media)
	if (Object.keys(mediaFields).length) PROVIDER_MEDIA[entry.id] = mediaFields as MediaConfig
}

// TTS model/voice tables keyed by special names (openai-tts-models, ...), not provider ids
Object.assign(PROVIDER_MODELS, buildTtsProviderModels())
