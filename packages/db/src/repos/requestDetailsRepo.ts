import { getAdapter } from "../driver.ts"
import { parseJson, stringifyJson } from "../helpers/jsonCol.ts"
import type { DbRow } from "../types.ts"
import { buildAllowedModelsSql, isAllowedModelPatterns } from "./allowedModels.ts"

const DEFAULT_MAX_RECORDS = 200
const DEFAULT_BATCH_SIZE = 20
const DEFAULT_FLUSH_INTERVAL_MS = 5000
const DEFAULT_MAX_JSON_SIZE = 5 * 1024
const CONFIG_CACHE_TTL_MS = 5000

/** The batching thresholds the observability writer works to. */
interface ObservabilityConfig {
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
interface TruncatedField {
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

async function getObservabilityConfig(): Promise<ObservabilityConfig> {
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

const writeBuffer: RequestDetail[] = []
let flushTimer: NodeJS.Timeout | null = null
let isFlushing = false

function sanitizeHeaders(headers: unknown): Record<string, string> {
	if (!headers || typeof headers !== "object") return {}
	const sensitiveKeys = ["authorization", "x-api-key", "cookie", "token", "api-key"]
	const sanitized: Record<string, string> = { ...(headers as Record<string, string>) }
	for (const key of Object.keys(sanitized)) {
		if (sensitiveKeys.some((s) => key.toLowerCase().includes(s))) delete sanitized[key]
	}
	return sanitized
}

export const __test__ = { sanitizeHeaders }

function generateDetailId(model: string | null | undefined): string {
	const timestamp = new Date().toISOString()
	const random = Math.random().toString(36).substring(2, 8)
	const modelPart = model ? model.replace(/[^a-zA-Z0-9-]/g, "-") : "unknown"
	return `${timestamp}-${random}-${modelPart}`
}

function truncateField(obj: unknown, maxSize: number): unknown {
	const str = JSON.stringify(obj || {})
	if (str.length > maxSize) {
		const truncated: TruncatedField = {
			_truncated: true,
			_originalSize: str.length,
			_preview: str.substring(0, 200),
		}
		return truncated
	}
	return obj || {}
}

/** Persist one batch of buffered details, then trim the table to `maxRecords`. */
async function flushBatch(items: RequestDetail[], config: ObservabilityConfig): Promise<void> {
	const db = await getAdapter()
	db.transaction(() => {
		for (const item of items) {
			if (!item.id) item.id = generateDetailId(item.model)
			if (!item.timestamp) item.timestamp = new Date().toISOString()
			if (item.request?.headers) item.request.headers = sanitizeHeaders(item.request.headers)

			const record = {
				id: item.id,
				provider: item.provider || null,
				model: item.model || null,
				connectionId: item.connectionId || null,
				timestamp: item.timestamp,
				status: item.status || null,
				latency: item.latency || {},
				tokens: item.tokens || {},
				request: truncateField(item.request, config.maxJsonSize),
				providerRequest: truncateField(item.providerRequest, config.maxJsonSize),
				providerResponse: truncateField(item.providerResponse, config.maxJsonSize),
				response: truncateField(item.response, config.maxJsonSize),
				pxpipe: item.pxpipe || undefined,
				resolvedModel: item.resolvedModel || undefined,
			}

			db.run(
				`INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET timestamp = excluded.timestamp, provider = excluded.provider, model = excluded.model, connectionId = excluded.connectionId, status = excluded.status, data = excluded.data`,
				[
					record.id,
					record.timestamp,
					record.provider,
					record.model,
					record.connectionId,
					record.status,
					stringifyJson(record),
				],
			)
		}

		const cnt = db.get<{ c: number }>(`SELECT COUNT(*) as c FROM requestDetails`)
		if (cnt && cnt.c > config.maxRecords) {
			db.run(
				`DELETE FROM requestDetails WHERE id IN (SELECT id FROM requestDetails ORDER BY timestamp ASC LIMIT ?)`,
				[cnt.c - config.maxRecords],
			)
		}
	})
}

async function flushToDatabase(): Promise<void> {
	if (isFlushing) return
	if (writeBuffer.length === 0) return
	isFlushing = true
	try {
		// Drain entire buffer (loop in case more pushed during await)
		while (writeBuffer.length > 0) {
			const items = writeBuffer.splice(0, writeBuffer.length)
			const config = await getObservabilityConfig()
			await flushBatch(items, config)
		}
	} catch (e) {
		console.error("[requestDetailsRepo] Batch write failed:", e)
	} finally {
		isFlushing = false
	}
}

export async function saveRequestDetail(detail: RequestDetail): Promise<void> {
	const config = await getObservabilityConfig()
	if (!config.enabled) {
		return
	}

	writeBuffer.push(detail)

	// Trigger immediate flush if batch threshold reached.
	// flushToDatabase() drains entire buffer in a loop, so all pushes during await are persisted.
	if (writeBuffer.length >= config.batchSize) {
		if (flushTimer) {
			clearTimeout(flushTimer)
			flushTimer = null
		}
		flushToDatabase().catch((e) => console.error("[requestDetailsRepo] flush err:", e))
	} else if (!flushTimer) {
		flushTimer = setTimeout(() => {
			flushTimer = null
			flushToDatabase().catch(() => {})
		}, config.flushIntervalMs)
	}
}

/** Filters accepted by getRequestDetails (all optional). */
export interface RequestDetailsFilter {
	provider?: string
	model?: string
	connectionId?: string
	status?: string
	startDate?: string | number | Date
	endDate?: string | number | Date
	/** `null`/`undefined` (or a pattern list containing `*`) means every model. */
	allowedModelPatterns?: unknown
	page?: number
	pageSize?: number
}

/** One page of request details, plus the counts the dashboard paginates with. */
export interface RequestDetailsPage {
	details: unknown[]
	pagination: {
		page: number
		pageSize: number
		totalItems: number
		totalPages: number
		hasNext: boolean
		hasPrev: boolean
	}
}

export async function getRequestDetails(
	filter: RequestDetailsFilter = {},
): Promise<RequestDetailsPage> {
	const db = await getAdapter()
	const conds: string[] = []
	const params: unknown[] = []

	if (filter.provider) {
		conds.push("provider = ?")
		params.push(filter.provider)
	}
	if (filter.model) {
		conds.push("model = ?")
		params.push(filter.model)
	}
	if (filter.connectionId) {
		conds.push("connectionId = ?")
		params.push(filter.connectionId)
	}
	if (filter.status) {
		conds.push("status = ?")
		params.push(filter.status)
	}
	if (filter.startDate) {
		conds.push("timestamp >= ?")
		params.push(new Date(filter.startDate).toISOString())
	}
	if (filter.endDate) {
		conds.push("timestamp <= ?")
		params.push(new Date(filter.endDate).toISOString())
	}
	// Scoped sessions narrow the listing to the models their key may actually use.
	const allowedPatterns = isAllowedModelPatterns(filter.allowedModelPatterns)
		? filter.allowedModelPatterns
		: null
	const allowed = buildAllowedModelsSql(allowedPatterns)
	if (allowed) {
		conds.push(allowed.sql)
		params.push(...allowed.params)
	}

	const where = conds.length ? `WHERE ${conds.join(" AND ")}` : ""
	const cntRow = db.get<{ c: number }>(`SELECT COUNT(*) as c FROM requestDetails ${where}`, params)
	const totalItems = cntRow ? cntRow.c : 0

	const page = filter.page || 1
	const pageSize = filter.pageSize || 50
	const totalPages = Math.ceil(totalItems / pageSize)
	const offset = (page - 1) * pageSize

	const rows = db.all<DbRow>(
		`SELECT data FROM requestDetails ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
		[...params, pageSize, offset],
	)
	const details = rows.map((r) => parseJson(r.data, {}))

	return {
		details,
		pagination: {
			page,
			pageSize,
			totalItems,
			totalPages,
			hasNext: page < totalPages,
			hasPrev: page > 1,
		},
	}
}

export async function getDistinctProviders(
	allowedModelPatterns: unknown = null,
): Promise<unknown[]> {
	const db = await getAdapter()
	// The dashboard passes a session value it cannot vouch for, so narrow it here.
	const patterns = isAllowedModelPatterns(allowedModelPatterns) ? allowedModelPatterns : null
	const allowed = buildAllowedModelsSql(patterns)
	const where = allowed ? `provider IS NOT NULL AND ${allowed.sql}` : "provider IS NOT NULL"
	const rows = db.all<DbRow>(
		`SELECT DISTINCT provider FROM requestDetails WHERE ${where} ORDER BY provider ASC`,
		allowed ? allowed.params : [],
	)
	return rows.map((r) => r.provider)
}

export async function getRequestDetailById(id: string): Promise<unknown> {
	const db = await getAdapter()
	const row = db.get<DbRow>(`SELECT data FROM requestDetails WHERE id = ?`, [id])
	return row ? parseJson(row.data, null) : null
}

const _shutdownHandler = async () => {
	if (flushTimer) {
		clearTimeout(flushTimer)
		flushTimer = null
	}
	if (writeBuffer.length > 0) await flushToDatabase()
}

// Process-global registry of shutdown handlers.
//
// A module-local `off` then `on` is not enough: when this module is evaluated
// more than once in the same process (vitest vi.resetModules(), hot reload, or
// any second import path) each evaluation gets a *distinct* _shutdownHandler
// closure, so `off` can only remove its own — every previous instance stays
// attached forever. The suite accumulated 11+ listeners and tripped
// MaxListenersExceededWarning. Keeping the live handlers on globalThis lets a
// fresh instance retire the stale ones it cannot otherwise reach.
const SHUTDOWN_EVENTS = ["beforeExit", "SIGINT", "SIGTERM", "exit"] as const
type ShutdownRegistry = { handlers: Set<() => unknown>; dispatch: () => void }
const REGISTRY_KEY = "__9routerRequestDetailsShutdown"

function getShutdownRegistry(): ShutdownRegistry {
	const g = globalThis as typeof globalThis & { [REGISTRY_KEY]?: ShutdownRegistry }
	if (!g[REGISTRY_KEY]) {
		const handlers = new Set<() => unknown>()
		// One dispatcher for all events: it fans out to whichever handlers are live
		// right now, so handlers registered later are still reached.
		const dispatch = () => {
			for (const h of handlers) {
				try {
					void h()
				} catch {
					/* fail-open: one bad flush must not block the rest */
				}
			}
		}
		g[REGISTRY_KEY] = { handlers, dispatch }
		for (const ev of SHUTDOWN_EVENTS) process.on(ev, dispatch)
	}
	return g[REGISTRY_KEY]
}

function ensureShutdownHandler() {
	const registry = getShutdownRegistry()
	// Retire handlers left behind by any earlier evaluation of this module. They
	// close over a dead writeBuffer, so running them could flush an empty buffer
	// against a closed adapter.
	registry.handlers.clear()
	registry.handlers.add(_shutdownHandler as () => unknown)
}

ensureShutdownHandler()
