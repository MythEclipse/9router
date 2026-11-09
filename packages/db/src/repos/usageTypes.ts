/**
 * Usage report types.
 *
 * Extracted verbatim from usageRepo.ts so the repo barrel stays under the
 * file-size budget. usageRepo re-exports these, so `from "./usageRepo.ts"`
 * importers are unaffected.
 */

export interface UsageTokens {
	prompt_tokens?: number
	input_tokens?: number
	completion_tokens?: number
	output_tokens?: number
	cached_tokens?: number
	cache_read_input_tokens?: number
	[key: string]: number | undefined
}

/** One finished (or lifecycle) request, as the write path receives it. */
export interface UsageEntry {
	provider?: string | null
	model?: string | null
	resolvedModel?: string | null
	connectionId?: string | null
	apiKey?: string | null
	endpoint?: string | null
	timestamp?: string
	cost?: number
	status?: string | null
	tokens?: UsageTokens | null
	/** What the caller asked for, when routing rewrote the model. */
	requestedModel?: string | null
	/** Correlation id for the log row; see the dedupe note in saveRequestUsage. */
	requestId?: string | number | null
	/**
	 * Wall-clock duration of the request in milliseconds.
	 *
	 * Absent means "not measured", which is stored as `NULL` and excluded from every
	 * percentile. A caller that does not measure latency must not report `0` — a zero is a
	 * measurement, and it would claim the request finished instantly.
	 */
	latencyMs?: number | null
	/** Time to first token. Only a streamed answer has one. */
	ttftMs?: number | null
	/** True when the answer came from the prompt cache rather than an upstream call. */
	cached?: boolean
	[key: string]: unknown
}

/** Counters kept per bucket (provider/model/account/key/endpoint). */
export interface UsageCounter {
	requests: number
	promptTokens: number
	completionTokens: number
	cachedTokens: number
	cost: number
	lastUsed?: string
	rawModel?: string | null
	provider?: string | null
	resolvedModel?: string | null
	apiKey?: string | null
	apiKeyMasked?: string | null
	keyName?: string
	apiKeyKey?: string
	endpoint?: string | null
	[key: string]: unknown
}

/** One bucket collection keyed by an arbitrary composite key. */
export type UsageCounters = Record<string, UsageCounter>

/** The per-day aggregate stored as one JSON blob in `usageDaily`. */
export interface UsageDay {
	requests: number
	promptTokens: number
	completionTokens: number
	cost: number
	cachedTokens?: number
	byProvider?: UsageCounters
	byModel?: UsageCounters
	byAccount?: UsageCounters
	byApiKey?: UsageCounters
	byEndpoint?: UsageCounters
	[key: string]: unknown
}

export interface UsageBucket {
	requests: number
	promptTokens: number
	completionTokens: number
	cost: number
}

/** Per-model stats gain the raw/resolved model and a last-used stamp. */
export type ModelUsageCounter = UsageCounter

/** Per-account stats also carry the connection they belong to. */
export interface AccountUsageCounter extends UsageCounter {
	connectionId?: string | null
	accountName?: string
}

/** One bar on the usage chart. */
export interface ChartBucket {
	label?: string
	tokens: number
	cost: number
	requests: number
}

/** The shape GET /api/usage/stats returns. */
export interface UsageStats {
	totalRequests: number
	totalPromptTokens: number
	totalCompletionTokens: number
	totalCachedTokens: number
	totalCost: number
	byProvider: UsageCounters
	byModel: Record<string, ModelUsageCounter>
	byAccount: Record<string, AccountUsageCounter>
	byApiKey: UsageCounters
	byEndpoint: UsageCounters
	last10Minutes: UsageBucket[]
	pending: unknown
	activeRequests: ActiveRequest[]
	recentRequests: RecentRequest[]
	errorProvider: string
	[key: string]: unknown
}

/** One live request, as the dashboard lists it. */
export interface ActiveRequest {
	model: string
	provider: string
	account: string
	count: number
}

/** The identifying bits of an api key a dashboard label may use. */
export interface ApiKeyLabel {
	name: string
	id: string
	createdAt: string
}

/** One finished request, as the dashboard lists it. */
export interface RecentRequest {
	timestamp: string
	model: string
	/** The name the caller asked for, when it differs from the serving model. */
	requestedModel?: string
	provider: string
	promptTokens: number
	completionTokens: number
	cachedTokens: number
	status: string
}

/** Filters accepted by getUsageHistory. */
export interface UsageHistoryFilter {
	provider?: string
	model?: string
	startDate?: string | number | Date
	endDate?: string | number | Date
	apiKey?: string
}

/** One usageHistory row as the dashboard consumes it. */
export interface UsageHistoryRecord {
	timestamp: string
	provider: string | null
	model: string | null
	connectionId: string | null
	/** Never the raw secret: see apiKeyBucketId's note on AUDIT-002. */
	apiKeyMasked: string | null
	endpoint: string | null
	cost: number
	status: string | null
	tokens: UsageTokens
	resolvedModel: string | null
}
