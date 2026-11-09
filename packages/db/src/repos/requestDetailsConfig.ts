/**
 * Observability config and request-detail types.
 *
 * Extracted verbatim from requestDetailsRepo.ts.
 */

const DEFAULT_MAX_RECORDS = 200
const DEFAULT_BATCH_SIZE = 20
const DEFAULT_FLUSH_INTERVAL_MS = 5000
const DEFAULT_MAX_JSON_SIZE = 5 * 1024
const CONFIG_CACHE_TTL_MS = 5000

/** The batching thresholds the observability writer works to. */
export interface ObservabilityConfig {
	enabled: boolean
	maxRecords: number
	batchSize: number
	flushIntervalMs: number
	maxJsonSize: number
}

/**
 * A request-detail record, as handed to `saveRequestDetail`.
 *
 * Everything but `id` is optional: callers build these incrementally on the
 * request path, and the flush fills in the id and timestamp.
 */
export interface RequestDetail {
	id?: string
	provider?: string | null
	model?: string | null
	connectionId?: string | null
	timestamp?: string
	status?: string | null
	latency?: unknown
	tokens?: unknown
	request?: { headers?: Record<string, string> | null; [key: string]: unknown } | null
	providerRequest?: unknown
	providerResponse?: unknown
	response?: unknown
	pxpipe?: unknown
	resolvedModel?: string
	[key: string]: unknown
}

/** A field replaced by a preview when it exceeds `maxJsonSize`. */
export interface TruncatedField {
	_truncated: true
	_originalSize: number
	_preview: string
}

let cachedConfig: ObservabilityConfig | null = null
let cachedConfigTs = 0

/** Read the batch thresholds from settings, falling back to the environment then the defaults. */
async function readConfigFromSettings(): Promise<ObservabilityConfig> {
	const { getSettings } = await import("./settingsRepo.ts")
	const settings = await getSettings()
	const envRequestLogs = process.env.ENABLE_REQUEST_LOGS
	let enabled: boolean
	if (envRequestLogs !== undefined) {
		enabled = envRequestLogs.toLowerCase() === "true"
	} else {
		const envFallback = process.env.OBSERVABILITY_ENABLED !== "false"
		const uiFlag = typeof settings.enableObservability === "boolean"
		enabled = uiFlag ? settings.enableObservability : envFallback
	}
	return {
		enabled,
		maxRecords:
			settings.observabilityMaxRecords ||
			parseInt(process.env.OBSERVABILITY_MAX_RECORDS || String(DEFAULT_MAX_RECORDS), 10),
		batchSize:
			settings.observabilityBatchSize ||
			parseInt(process.env.OBSERVABILITY_BATCH_SIZE || String(DEFAULT_BATCH_SIZE), 10),
		flushIntervalMs:
			settings.observabilityFlushIntervalMs ||
			parseInt(process.env.OBSERVABILITY_FLUSH_INTERVAL_MS || String(DEFAULT_FLUSH_INTERVAL_MS), 10),
		maxJsonSize:
			(settings.observabilityMaxJsonSize ||
				parseInt(process.env.OBSERVABILITY_MAX_JSON_SIZE || "5", 10)) * 1024,
	}
}

export async function getObservabilityConfig(): Promise<ObservabilityConfig> {
	if (cachedConfig && Date.now() - cachedConfigTs < CONFIG_CACHE_TTL_MS) return cachedConfig
	try {
		cachedConfig = await readConfigFromSettings()
	} catch {
		cachedConfig = {
			enabled: false,
			maxRecords: DEFAULT_MAX_RECORDS,
			batchSize: DEFAULT_BATCH_SIZE,
			flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
			maxJsonSize: DEFAULT_MAX_JSON_SIZE,
		}
	}
	cachedConfigTs = Date.now()
	return cachedConfig
}
