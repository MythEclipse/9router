/**
 * Settings types and defaults.
 *
 * Extracted verbatim from settingsRepo.ts.
 */

import { CUSTOM_PLUGIN_KEYS } from "@9router/db/shared/pluginKeys"

const DEFAULT_MITM_ROUTER_BASE = "http://localhost:20128"
const DEFAULT_HEADROOM_URL = process.env.HEADROOM_URL || "http://localhost:8787"

/** One capacity class (vision, pdf, ...) and the models routed through it. */
export interface CapacityAdapterEntry {
	enabled: boolean
	roundRobin: boolean
	/** Models may carry legacy ids; `mergeWithDefaults` upgrades them. */
	models: unknown[]
}

/** Per-plugin enablement, keyed by `CUSTOM_PLUGIN_KEYS`. */
export interface CustomPluginSetting {
	enabled: boolean
	/** The model ids this plugin is applied to. */
	models: string[]
	[key: string]: unknown
}

/**
 * A combo's routing strategy, keyed by combo name in `comboStrategies`.
 *
 * Open-ended because providers and combos can carry tuning this module never
 * reads; only the fields the gateway and the dashboards branch on are named.
 */
export interface ComboStrategy {
	fallbackStrategy?: string
	judgeModel?: string
	fusionTuning?: unknown
	smartPolicy?: string
	sessionSticky?: boolean
	confidenceThreshold?: number
	routerModel?: string
	/**
	 * Per-combo memory tuning. Same fields as the global `memory` block; it can
	 * retune an enabled stage but never enable one the operator left off.
	 */
	memory?: Partial<MemorySettings>
	[key: string]: unknown
}

/**
 * The Hindsight-backed memory stage.
 *
 * One shared bank, isolated by a gateway-assigned principal tag rather than by
 * bank separation — see `apps/web/src/lib/memory/principal.ts`. `includeShared`
 * decides whether recall also returns the bank's untagged corpus.
 */
export interface MemorySettings {
	enabled: boolean
	baseUrl: string
	/** Bearer token for the Hindsight deployment; never returned to a browser. */
	apiKey: string
	bankId: string
	recall: boolean
	retain: boolean
	includeShared: boolean
	/**
	 * Extra tags OR'd into every recall, for a bank whose shared corpus is tagged
	 * (`host:omarchy`, `knowledge:decision`) rather than left untagged. Read-side
	 * only: the gateway never writes these, so a caller cannot reach another
	 * principal's write scope by naming one.
	 */
	sharedTags: string[]
	/** Extra tags stamped on retain. Keep empty for a public combo — see MemoryConfig. */
	retainTags: string[]
	recallBudget: string
	recallMaxTokens: number
	timeoutMs: number
}

/** A provider's account-rotation strategy, keyed by provider id. */
export interface ProviderStrategy {
	rotateStrategy?: string
	proxyPoolId?: string | null
	[key: string]: unknown
}

/** Per-provider auto-ping configuration (claude / codex). */
export interface AutoPingSettings {
	connections?: Record<string, unknown>
	schedules?: Record<string, { enabled?: boolean }>
}

/**
 * The settings object the app reads.
 *
 * Deliberately open (`[key: string]: unknown`): the raw row is operator data and
 * may hold keys this build does not know — `quotaAutoPing` reaches providers
 * through a dynamic `settingsKey`, and `getCloudUrl` reads `cloudUrl`, which no
 * default declares. Naming the fields the code actually touches keeps property
 * access typed without pretending the row is closed.
 */
export interface Settings {
	cloudEnabled: boolean
	cloudUrl?: string
	tunnelEnabled: boolean
	tunnelUrl: string
	tailscaleEnabled: boolean
	tailscaleUrl: string
	stickyRoundRobinLimit: number
	providerStrategies: Record<string, ProviderStrategy>
	quotaVisibility: Record<string, unknown>
	comboStrategy: string
	comboStickyRoundRobinLimit: number
	comboStrategies: Record<string, ComboStrategy>
	capacityAdapter: Record<string, CapacityAdapterEntry>
	customPlugins: Record<string, CustomPluginSetting>
	/** Hindsight-backed memory stage: one shared bank, isolated by principal tag. */
	memory: MemorySettings
	requireLogin: boolean
	antiProbeMetadata: boolean
	requireApiKey: boolean
	theme: string
	tunnelDashboardAccess: boolean
	authMode: string
	ssoType: string
	oidcIssuerUrl: string
	oidcClientId: string
	oidcClientSecret: string
	oidcScopes: string
	oidcLoginLabel: string
	samlEntryPoint: string
	samlIssuer: string
	samlCert: string
	samlLoginLabel: string
	samlAttributeEmail: string
	samlAttributeName: string
	enableObservability: boolean
	observabilityMaxRecords: number
	observabilityBatchSize: number
	observabilityFlushIntervalMs: number
	observabilityMaxJsonSize: number
	observabilityIncludePayloads: boolean
	outboundProxyEnabled: boolean
	outboundProxyUrl: string
	outboundProxyNoProxy?: string
	outboundNoProxy: string
	mitmRouterBaseUrl: string
	dnsToolEnabled: Record<string, unknown>
	rtkEnabled: boolean
	headroomEnabled: boolean
	headroomUrl: string
	headroomCompressUserMessages: boolean
	headroomTimeoutMs: number
	cavemanEnabled: boolean
	contextPruningLevel: string
	semanticCacheTtlHours: number
	semanticCacheMaxEntries: number
	cavemanLevel: string
	ponytailEnabled: boolean
	ponytailLevel: string
	customPromptEnabled: boolean
	customPrompt: string
	pxpipeEnabled: boolean
	pxpipeAutoInstall: boolean
	pxpipeMinChars: number
	pxpipeTimeoutMs: number
	hideError: boolean
	providerOverrides: Record<string, unknown>
	/** Per-provider auto-ping schedules the startup check reads. */
	claudeAutoPing?: AutoPingSettings | null
	codexAutoPing?: AutoPingSettings | null
	/** The dashboard password hash (`bcrypt`); absent on a passwordless install. */
	password?: string
	/** The MITM proxy toggle; the startup path resumes it when set. */
	mitmEnabled?: boolean
	[key: string]: unknown
}

/** A settings patch: any subset of the known keys, plus operator-only extras. */
export type SettingsUpdate = Partial<Settings> & Record<string, unknown>

/** A memoised value with the instant it goes stale. */
export interface CacheEntry<T> {
	value: T | null
	expiresAt: number
}

export const DEFAULT_SETTINGS = {
	cloudEnabled: false,
	tunnelEnabled: false,
	tunnelUrl: "",
	// No `tunnelProvider` selector: Cloudflare and Tailscale are independent
	// tunnels (each with its own enable/disable route and its own `*Enabled` flag
	// below), so a single "which tunnel provider" enum could never be read
	// without contradicting both. The key used to sit here unread by any code.
	tailscaleEnabled: false,
	tailscaleUrl: "",
	stickyRoundRobinLimit: 3,
	providerStrategies: {},
	quotaVisibility: {},
	comboStrategy: "fallback",
	comboStickyRoundRobinLimit: 1,
	comboStrategies: {},
	capacityAdapter: {
		vision: { enabled: true, roundRobin: false, models: [] as string[] },
		pdf: { enabled: false, roundRobin: false, models: [] as string[] },
		audioInput: { enabled: true, roundRobin: false, models: [] as string[] },
		videoInput: { enabled: false, roundRobin: false, models: [] as string[] },
	},
	// Keys come from CUSTOM_PLUGIN_KEYS so a new plugin cannot be missing here;
	// this literal had five entries while six plugins existed.
	customPlugins: Object.fromEntries(
		CUSTOM_PLUGIN_KEYS.map((key) => [key, { enabled: false, models: [] as string[] }]),
	),
	requireLogin: true,
	// Hindsight-backed memory stage. Off by default: it is an external service
	// with a per-turn cost, so it must be a deliberate opt-in.
	//
	// `includeShared: true` returns the bank's untagged corpus alongside this
	// caller's own memories. Turn it off for a public combo whose bank has no
	// curated shared material, so one bank behaves like one bank per caller.
	memory: {
		enabled: false,
		baseUrl: process.env.HINDSIGHT_URL || "http://localhost:8888",
		apiKey: process.env.HINDSIGHT_API_KEY || "",
		bankId: "9router",
		recall: true,
		retain: true,
		includeShared: true,
		sharedTags: [],
		retainTags: [],
		recallBudget: "mid",
		recallMaxTokens: 1200,
		timeoutMs: 800,
	} satisfies MemorySettings,
	// Custom-model editor: warn about name/owned_by that claim a vendor the
	// target model does not match. Persisted so every administrator sees the
	// same editor rather than each browser deciding for itself.
	antiProbeMetadata: true,
	requireApiKey: true,
	// Site-wide theme (glass | dark). An administrator picks it once here instead
	// of every browser choosing its own: the value is rendered into the document
	// for all visitors, so the whole site matches what the admin selected.
	theme: "glass",
	tunnelDashboardAccess: true,
	authMode: "password",
	ssoType: "oidc",
	oidcIssuerUrl: "",
	oidcClientId: "",
	oidcClientSecret: "",
	oidcScopes: "openid profile email",
	oidcLoginLabel: "Sign in with OIDC",
	samlEntryPoint: "",
	samlIssuer: "urn:9router:sp",
	samlCert: "",
	samlLoginLabel: "Sign in with SAML SSO",
	samlAttributeEmail: "email",
	samlAttributeName: "name",
	enableObservability: false,
	observabilityMaxRecords: 1000,
	observabilityBatchSize: 20,
	observabilityFlushIntervalMs: 5000,
	observabilityMaxJsonSize: 5,
	// Payload bodies (prompts, tool calls, provider responses) are returned by
	// GET /api/usage/request-details only when this is on.
	//
	// Defaults to TRUE: this is a single-operator local gateway, and the logs view
	// exists to show what a request actually contained — a redacted-by-default
	// observability tab shows a request that used 244k tokens with no content and
	// no way to tell why, which is the bug it is supposed to help diagnose. The
	// exposure is contained by the dashboard auth gate (/api/usage/* requires a
	// session) rather than by stripping the payloads.
	//
	// Turn it off on a shared or internet-facing instance: with requireLogin
	// disabled, anyone who can reach the port can read every prompt and response.
	observabilityIncludePayloads: true,
	outboundProxyEnabled: false,
	outboundProxyUrl: "",
	outboundNoProxy: "",
	mitmRouterBaseUrl: DEFAULT_MITM_ROUTER_BASE,
	dnsToolEnabled: {},
	rtkEnabled: true,
	headroomEnabled: false,
	headroomUrl: DEFAULT_HEADROOM_URL,
	headroomCompressUserMessages: false,
	headroomTimeoutMs: 3000,
	cavemanEnabled: false,
	contextPruningLevel: "full",
	semanticCacheTtlHours: 3,
	semanticCacheMaxEntries: 1000,
	cavemanLevel: "full",
	ponytailEnabled: false,
	ponytailLevel: "full",
	// User-authored system prompt, injected independently of the built-in savers.
	customPromptEnabled: false,
	customPrompt: "",
	pxpipeEnabled: false,
	pxpipeAutoInstall: true,
	pxpipeMinChars: 25000,
	pxpipeTimeoutMs: 15000,
	hideError: false,
	// Per-provider user header overrides applied at dispatch: { [providerId]: { headers: {..} } }
	providerOverrides: {},
}
