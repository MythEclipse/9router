/**
 * Global state this package keeps across module reloads.
 *
 * Next's dev server re-evaluates modules on every edit, so live counters,
 * timers and the stats emitter have to survive on `globalThis` or the dashboard
 * resets them mid-request. The declarations here are the single place that says
 * what those keys hold; each module reads them with the type it needs.
 *
 * Declaring them is also what lets `noImplicitAny` pass: without it every
 * `global._pendingRequests` is an index into `typeof globalThis`, which has no
 * index signature.
 */
import type { EventEmitter } from "node:events"

/** One rate-limited request in a key's sliding window. */
export interface ApiKeyRateEvent {
	ts: number
	tokens: number
}

/** Per-key RPM/TPM sliding windows: API key string to its recent events. */
export type ApiKeyRateLimits = Record<string, ApiKeyRateEvent[]>

/**
 * Memoised API-key list. `null` means "not cached"; the reader re-queries when
 * it sees `null`, so the payload shape is left to the module that fills it.
 */
export type ApiKeyListCache = unknown

declare global {
	var _pendingRequests:
		| { byModel: Record<string, number>; byAccount: Record<string, Record<string, number>> }
		| undefined
	var _lastErrorProvider: { provider: string; ts: number } | undefined
	var _statsEmitter: EventEmitter | undefined
	var _pendingTimers: Record<string, NodeJS.Timeout | undefined> | undefined
	var _recentRing: { items: unknown[]; initialized: boolean } | undefined
	var _connectionMapCache: { map: Record<string, unknown>; ts: number } | undefined
	var _statsEmitTimers: { pending: NodeJS.Timeout | null; update: NodeJS.Timeout | null } | undefined
	var _apiKeyRateLimits: ApiKeyRateLimits | undefined
	var _apiKeyListCache: ApiKeyListCache | undefined
}
