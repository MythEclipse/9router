import { CUSTOM_PLUGIN_KEYS } from "@9router/db/shared/pluginKeys"
import { getAdapter } from "../driver.ts"
import { parseJson, stringifyJson } from "../helpers/jsonCol.ts"

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
	[key: string]: unknown
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
interface CacheEntry<T> {
	value: T | null
	expiresAt: number
}

const DEFAULT_SETTINGS = {
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

async function readRaw() {
	const db = await getAdapter()
	const row = db.get(`SELECT data FROM settings WHERE id = 1`)
	return row ? parseJson(row.data, {}) : {}
}

/**
 * Raw settings row, memoised.
 *
 * `getSettings()` is called ~6 times per chat request (handler auth gate, combo
 * expansion, per-account dispatch, sibling handlers) and each call re-reads and
 * re-parses the row from SQLite — 17-26us apiece, on the request path, in a
 * process where every DB call blocks the event loop. Nothing about the row
 * changes between those calls.
 *
 * The cache holds the RAW row (not the merged object): `mergeWithDefaults`
 * mutates the nested `capacityAdapter` entries it walks, so handing every caller
 * one shared merged object would let one caller's write through to the next
 * request. Merging is ~5us and stays per-call; this only removes the query.
 *
 * Invalidation: `updateSettings` and `importDb` clear it (single-process gateway,
 * and this is the only writer), and the TTL bounds anything that writes the row
 * behind our back.
 */
const RAW_CACHE_TTL_MS = 2000
let rawCache: CacheEntry<SettingsUpdate> = { value: null, expiresAt: 0 }

function invalidateRawCache() {
	rawCache = { value: null, expiresAt: 0 }
}

async function readRawCached(): Promise<SettingsUpdate> {
	const now = Date.now()
	if (rawCache.value && rawCache.expiresAt > now) return rawCache.value
	const value = await readRaw()
	rawCache = { value, expiresAt: now + RAW_CACHE_TTL_MS }
	return value
}

// Merge raw settings with defaults; backward-compat for missing keys
export function mergeWithDefaults(raw: unknown): Settings {
	const merged = { ...DEFAULT_SETTINGS, ...(raw as SettingsUpdate | null | undefined) } as Settings
	for (const [key, defVal] of Object.entries(DEFAULT_SETTINGS)) {
		if (merged[key] === undefined) {
			if (
				key === "outboundProxyEnabled" &&
				typeof merged.outboundProxyUrl === "string" &&
				merged.outboundProxyUrl.trim()
			) {
				merged[key] = true
			} else {
				merged[key] = defVal
			}
		}
	}
	if (merged.capacityAdapter && typeof merged.capacityAdapter === "object") {
		for (const capKey of Object.keys(merged.capacityAdapter)) {
			const entry = merged.capacityAdapter[capKey]
			if (Array.isArray(entry?.models)) {
				entry.models = entry.models.map((m) =>
					m === "oc/mimo-v2.5-free" ? "oc/mimo-v2.6-flash-free" : m,
				)
			}
		}
	}
	return merged
}

export async function getSettings(): Promise<Settings> {
	const raw = await readRawCached()
	return mergeWithDefaults(raw)
}

// Atomic read-merge-write inside transaction (prevents losing concurrent updates)
export async function updateSettings(updates: SettingsUpdate): Promise<Settings> {
	const db = await getAdapter()
	let next: SettingsUpdate = {}
	db.transaction(() => {
		const row = db.get<{ data?: string | null }>(`SELECT data FROM settings WHERE id = 1`)
		const current = (row ? parseJson(row.data, {}) : {}) as SettingsUpdate
		next = { ...current, ...updates }
		db.run(
			`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
			[stringifyJson(next)],
		)
	})
	// The memoised raw row is now stale — clear it before returning so the very
	// next getSettings() (including one inside this same request) sees the write.
	invalidateRawCache()
	return mergeWithDefaults(next)
}

/**
 * Drop the memoised settings row. Called by every writer of the settings table
 * (`updateSettings`, `importDb`) so a settings change is visible immediately
 * rather than after the TTL.
 */
export function invalidateSettingsCache() {
	invalidateRawCache()
}

export async function isCloudEnabled() {
	const settings = await getSettings()
	return settings.cloudEnabled === true
}

export async function getCloudUrl() {
	const settings = await getSettings()
	return settings.cloudUrl || process.env.CLOUD_URL || process.env.NEXT_PUBLIC_CLOUD_URL || ""
}

export async function exportSettings() {
	return await readRaw()
}
