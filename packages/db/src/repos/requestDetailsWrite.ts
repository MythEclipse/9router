/**
 * Request-detail write path (buffered batching + shutdown flush).
 *
 * Extracted verbatim from requestDetailsRepo.ts.
 */

import { getAdapter } from "../driver.ts"
import { stringifyJson } from "../helpers/jsonCol.ts"

import {
	getObservabilityConfig,
	type ObservabilityConfig,
	type RequestDetail,
	type TruncatedField,
} from "./requestDetailsConfig.ts"

export const writeBuffer: RequestDetail[] = []
export let flushTimer: NodeJS.Timeout | null = null
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

export async function flushToDatabase(): Promise<void> {
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
