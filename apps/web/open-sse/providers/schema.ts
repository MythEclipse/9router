// Provider transport schema: shared defaults + endpoint defaults + resolver.
//
// The registry is the single source of truth for provider metadata, and every
// provider file declares a different subset of the optional fields. The
// interfaces below therefore carry an index signature: known fields are typed
// (so call sites get completion and typos surface), while provider-specific
// extras stay assignable without editing this file for each new provider.
import { DEFAULT_RETRY_CONFIG, FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.ts"

/** Loose bag for provider-specific extras the shared types do not name. */
export type ProviderExtras = Record<string, unknown>

export interface TransportAuthConfig extends ProviderExtras {
	header?: string
	scheme?: string
	source?: string[]
}

export interface TransportRefreshConfig extends ProviderExtras {
	encoding?: string
	scope?: string
}

export interface TransportCopilotConfig extends ProviderExtras {
	vscodeVersion?: string
	chatVersion?: string
	userAgent?: string
	apiVersion?: string
}

/** Provider quota/usage metadata read by the usage services. */
export interface UsageConfig extends ProviderExtras {
	/** Primary usage endpoint (POST body varies per provider). */
	url?: string
	/** Grok CLI user profile endpoint. */
	userUrl?: string
	/** Kiro CodeWhisperer host endpoint. */
	cwHost?: string
	/** Cloud Code Assist `retrieveUserQuota` endpoint. */
	quotaUrl?: string
	/** Antigravity `fetchAvailableModels` endpoint. */
	quotaApiUrl?: string
	/** Antigravity `retrieveUserQuotaSummary` endpoint. */
	quotaSummaryApiUrl?: string
	/** Cloud Code Assist `loadCodeAssist` endpoint. */
	loadCodeAssistUrl?: string
	/** Antigravity `loadCodeAssist` endpoint. */
	loadProjectApiUrl?: string
	tokenUrl?: string
	baseUrl?: string
	/** OAuth usage endpoint (Claude subscription limits). */
	oauthUrl?: string
	/** Org-scoped usage endpoint; `{org_id}` is substituted at call time. */
	orgUrl?: string
	/** Org-scoped reset-grant endpoint; `{org_id}` is substituted at call time. */
	resetUrl?: string
	settingsUrl?: string
	profileUrl?: string
	[key: string]: unknown
}

export interface TransportConfig extends ProviderExtras {
	baseUrl?: string
	format?: string
	headers?: Record<string, string>
	auth?: TransportAuthConfig
	/** GitHub Copilot client identity (registry github.transport.copilot). */
	copilot?: TransportCopilotConfig
	forceStream?: boolean
	urlSuffix?: string
	quirks?: Record<string, unknown>
	retry?: Record<string, unknown>
	timeoutMs?: number
	executor?: string
	/** Injected from `oauth` by providers/index.ts - declare there, not here. */
	clientId?: string
	/** Injected from `oauth` by providers/index.ts - declare there, not here. */
	clientSecret?: string
	/** Injected from `oauth` by providers/index.ts - declare there, not here. */
	tokenUrl?: string
	refreshUrl?: string
	usage?: UsageConfig
	cliVersion?: string
	apiClient?: string
	regions?: Record<string, string>
	defaultRegion?: string
	/** Public model-catalogue endpoint used by freeCatalogSync (`url` + filter `type`). */
	modelsFetcher?: ModelsFetcherConfig
	validateUrl?: string
	responsesUrl?: string
	/** GitHub Copilot Anthropic-native shim (registry github.transport.messagesUrl). */
	messagesUrl?: string
	transports?: Record<string, TransportConfig>
}

/** Where to fetch a provider's public model catalogue, and which filter to apply. */
export interface ModelsFetcherConfig {
	url: string
	/** Key into FILTERS (src/app/api/providers/suggested-models/filters.ts). */
	type: string
}

export interface OAuthConfig extends ProviderExtras {
	/** GitHub REST `X-GitHub-Api-Version` header value. */
	apiVersion?: string
	/** GitHub Copilot `User-Agent` header value. */
	userAgent?: string
	clientId?: string
	authorizeUrl?: string
	tokenUrl?: string
	deviceCodeUrl?: string
	refreshUrl?: string
	scope?: string
	scopes?: string[]
	redirectUri?: string
	callbackPath?: string
	fixedPort?: number
	codeChallengeMethod?: string
	extraParams?: Record<string, string>
	refresh?: TransportRefreshConfig
	refreshLeadMs?: number
	userInfoUrl?: string
	/** Cursor AgentService base URL (live model catalog + agent RPCs). */
	agentEndpoint?: string
	agentNonPrivacyEndpoint?: string
	/** Path appended to `agentEndpoint` for the live model catalog. */
	modelsEndpoint?: string
	/** Proactive refresh window: refresh when the last refresh is older than this. */
	maxRefreshAgeMs?: number
	/** Stamp `lastRefreshAt` on every merged refresh, not only when a token changed. */
	trackRefreshAt?: boolean
	/** Google Cloud Code: where to exchange the token for a project id. */
	loadCodeAssistEndpoint?: string
	/** Google Cloud Code: where to activate a project once one is chosen. */
	onboardUserEndpoint?: string
	/** Google Cloud Code: the IDE user agent the endpoint expects. */
	loadCodeAssistUserAgent?: string
	/** Cursor: the client build the server fingerprints requests against. */
	clientVersion?: string
	/** Cursor: the client family (e.g. `ide`). */
	clientType?: string
}

export interface MediaServiceConfig extends ProviderExtras {
	baseUrl?: string
	path?: string
	authType?: string
	authHeader?: string
	format?: string
	defaultModel?: string
	models?: Array<Record<string, unknown>>
	modelMap?: Record<string, unknown>
}

export interface MediaConfig extends ProviderExtras {
	serviceKinds?: string[]
	ttsConfig?: MediaServiceConfig
	sttConfig?: MediaServiceConfig
	embeddingConfig?: MediaServiceConfig
	imageConfig?: MediaServiceConfig
	imageToTextConfig?: MediaServiceConfig
	videoConfig?: MediaServiceConfig
	musicConfig?: MediaServiceConfig
	searchViaChat?: { defaultModel?: string; pricingUrl?: string } & ProviderExtras
	searchConfig?: MediaServiceConfig
	fetchConfig?: MediaServiceConfig
	systemoneConfig?: MediaServiceConfig
	hiddenKinds?: string[]
	mediaPriority?: number
}

export interface ProviderDisplay extends ProviderExtras {
	name?: string
	icon?: string
	color?: string
	textIcon?: string
	website?: string
	notice?: Record<string, string>
	deprecated?: boolean
	deprecationNotice?: string
	kindNotice?: Record<string, string>
	mediaPriority?: number
}

export interface ProviderModelEntry extends ProviderExtras {
	id?: string
	name?: string
	dimensions?: number
}

/**
 * RegistryEntry - full contract for `registry/{id}.ts`. See REGISTRY_TEMPLATE.ts
 * for a worked example. Only `id` + `category` are strictly required.
 */
export interface RegistryEntry extends ProviderExtras {
	id: string
	category: string
	alias?: string
	aliases?: string[]
	uiAlias?: string
	authType?: string
	authModes?: string[]
	hasOAuth?: boolean
	noAuth?: boolean
	hidden?: boolean
	priority?: number
	display?: ProviderDisplay
	transport?: TransportConfig
	transports?: Record<string, TransportConfig>
	oauth?: OAuthConfig
	media?: MediaConfig
	models?: ProviderModelEntry[]
	features?: Record<string, unknown>
	thinkingConfig?: Record<string, unknown>
	passthroughModels?: boolean
	cliVersion?: string
	apiClient?: string
	regions?: Record<string, string>
	defaultRegion?: string
	/** Public model-catalogue endpoint used by freeCatalogSync (`url` + filter `type`). */
	modelsFetcher?: ModelsFetcherConfig
	serviceKinds?: string[]
	ttsConfig?: MediaServiceConfig
	sttConfig?: MediaServiceConfig
	embeddingConfig?: MediaServiceConfig
	imageConfig?: MediaServiceConfig
	imageToTextConfig?: MediaServiceConfig
	videoConfig?: MediaServiceConfig
	musicConfig?: MediaServiceConfig
	searchViaChat?: Record<string, unknown>
	searchConfig?: MediaServiceConfig
	fetchConfig?: MediaServiceConfig
	systemoneConfig?: MediaServiceConfig
	mediaPriority?: number
	hiddenKinds?: string[]
}

/** Provider id -> resolved transport config. */
export type ProviderRegistry = Record<string, TransportConfig>
/** Alias/id -> model list. */
export type ProviderModelRegistry = Record<string, ProviderModelEntry[]>
/** Provider id -> OAuth config. */
export type ProviderOAuthRegistry = Record<string, OAuthConfig>
/** Provider id -> media config. */
export type ProviderMediaRegistry = Record<string, MediaConfig>

// Shared transport defaults - provider only overrides fields that differ.
// NOTE: runtime (index.ts buildTransport) only re-applies `format`; the rest documents the contract
// and feeds resolveProvider(). Adding keys here does NOT change PROVIDERS.
export const PROVIDER_DEFAULTS: TransportConfig = {
	baseUrl: "",
	format: "openai",
	headers: {},
	auth: { header: "Authorization", scheme: "bearer", source: ["accessToken", "apiKey"] },
	forceStream: false,
	urlSuffix: "",
	quirks: {},
	passthroughModels: false,
	retry: DEFAULT_RETRY_CONFIG,
	timeoutMs: FETCH_CONNECT_TIMEOUT_MS,
	executor: "default",
}

// Default endpoints per format (provider only overrides what differs)
export const ENDPOINT_DEFAULTS = {
	openai: { chat: "/chat/completions", test: "/models", models: "/models" },
	claude: { chat: "/messages", test: "/models", countTokens: "/messages/count_tokens" },
	gemini: { chat: "/{model}:streamGenerateContent", models: "/models", test: "/models" },
}

// Deep-merge a provider entry over PROVIDER_DEFAULTS (defensive for missing transport)
export function resolveProvider(entry?: Pick<RegistryEntry, "transport"> | null): TransportConfig {
	const transport: TransportConfig = entry?.transport ?? {}
	return {
		...PROVIDER_DEFAULTS,
		...transport,
		headers: { ...PROVIDER_DEFAULTS.headers, ...transport.headers },
		auth: { ...PROVIDER_DEFAULTS.auth, ...transport.auth },
		quirks: { ...PROVIDER_DEFAULTS.quirks, ...transport.quirks },
		retry: { ...PROVIDER_DEFAULTS.retry, ...transport.retry },
	}
}
