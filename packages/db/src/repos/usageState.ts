/**
 * Process-shared usage state and small helpers.
 *
 * Extracted verbatim from usageRepo.ts. The globals live on `globalThis`
 * (Next.js may evaluate this module twice) — that behaviour is unchanged.
 * usageRepo re-exports what its callers expect.
 */

import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"

import type { UsageEntry } from "./usageTypes.ts"

export type ConnectionMap = Record<string, string>

export function maskApiKey(key: unknown): string | null {
	if (!key || typeof key !== "string") return null
	const trimmed = key.trim()
	if (trimmed.length <= 12) return trimmed.charAt(0) + "***"
	// Keep the tail: keys sharing a machine-id prefix (team keys) must not collide.
	return trimmed.slice(0, 8) + "***" + trimmed.slice(-4)
}

/**
 * Stable, non-reversible bucket id for a raw api key.
 *
 * `byApiKey` is keyed by raw api key (fix(usage) 4a57df8b) because keys minted
 * from the same machine id share their first 8 characters, so maskApiKey alone
 * collapsed every key of an instance into one bucket. But byApiKey is returned
 * verbatim by GET /api/usage/stats, so a raw key as a JSON *object key* leaks
 * the secret to any authenticated dashboard reader — the exact exposure
 * AUDIT-002 (#1962) closed.
 *
 * A digest keeps buckets distinct while putting nothing reversible on the wire.
 * SHA-256 over the raw key, truncated to 16 hex chars: collision-free for any
 * realistic key count, and the digest cannot be replayed against any upstream.
 */
export function apiKeyBucketId(key: string): string {
	return createHash("sha256").update(key).digest("hex").slice(0, 16)
}

export const PENDING_TIMEOUT_MS = 60 * 1000
export const RING_CAP = 50
export const CONN_CACHE_TTL_MS = 30 * 1000
export const PERIOD_MS: Record<string, number> = {
	"24h": 86400000,
	"7d": 604800000,
	"30d": 2592000000,
	"60d": 5184000000,
}

// In-memory state shared across Next.js modules
if (!global._pendingRequests) global._pendingRequests = { byModel: {}, byAccount: {} }
if (!global._lastErrorProvider) global._lastErrorProvider = { provider: "", ts: 0 }
if (!global._statsEmitter) {
	global._statsEmitter = new EventEmitter()
	global._statsEmitter.setMaxListeners(50)
}
if (!global._pendingTimers) global._pendingTimers = {}
if (!global._recentRing) global._recentRing = { items: [], initialized: false }
if (!global._connectionMapCache) global._connectionMapCache = { map: {}, ts: 0 }
if (!global._statsEmitTimers) global._statsEmitTimers = { pending: null, update: null }

/** Live request counters, keyed by composed model label and by account. */
export interface PendingRequests {
	byModel: Record<string, number>
	byAccount: Record<string, Record<string, number>>
}

export const pendingRequests = global._pendingRequests as PendingRequests
export const lastErrorProvider = global._lastErrorProvider as { provider: string; ts: number }
export const pendingTimers = global._pendingTimers as Record<string, NodeJS.Timeout | undefined>
export const recentRing = global._recentRing as { items: UsageEntry[]; initialized: boolean }
export const connCache = global._connectionMapCache as { map: ConnectionMap; ts: number }
export const statsEmitTimers = global._statsEmitTimers as {
	pending: NodeJS.Timeout | null
	update: NodeJS.Timeout | null
}

export const statsEmitter = global._statsEmitter as EventEmitter

export function scheduleStatsEvent(event: string, delayMs = 150): void {
	const key = event === "update" ? "update" : "pending"
	if (statsEmitTimers[key]) return
	statsEmitTimers[key] = setTimeout(() => {
		statsEmitTimers[key] = null
		statsEmitter.emit(event)
	}, delayMs)
	statsEmitTimers[key]?.unref?.()
}

export function getLocalDateKey(timestamp?: string | number | null): string {
	const d = timestamp ? new Date(timestamp) : new Date()
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

/**
 * A duration as it should be stored, or `NULL` when it was never measured.
 *
 * `0` is a real measurement (a cached answer takes no time), so it survives. Negative and
 * non-finite values do not: they come from a clock that moved backwards or from a caller
 * passing `NaN`, and either would drag a percentile below zero.
 */
export function measuredOf(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null
	return Math.round(value)
}

export function pushToRing(entry: UsageEntry): void {
	recentRing.items.push(entry)
	if (recentRing.items.length > RING_CAP) {
		recentRing.items = recentRing.items.slice(-RING_CAP)
	}
}
