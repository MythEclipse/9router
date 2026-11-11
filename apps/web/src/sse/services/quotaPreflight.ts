/**
 * Pre-flight quota reads: fill `open-sse/services/quotaExhaustion.ts` before selection runs.
 *
 * Selection cannot skip a parked account it has never heard of. Until now the only way it heard
 * was the account answering 409/429 — so a window that the dashboard had been showing at 0% for
 * six days still cost one request per rotation attempt. This module reads the same quota endpoint
 * the usage panel reads, and hands the result to the shared observation cache.
 *
 * The rules that keep it off the critical path:
 *
 * - **Cold reads are awaited, warm reads are not.** The first request after boot (or after a
 *   connection is added) waits, because selection has nothing else to go on. Every later read is
 *   refreshed in the background and the previous observation is used, so steady-state latency is
 *   unchanged.
 * - **One read per connection per TTL**, with in-flight de-duplication, so a burst of concurrent
 *   requests cannot multiply upstream quota calls.
 * - **Every failure is fail-open.** A quota endpoint that is slow, rate-limited or broken must
 *   never take the gateway down with it; the request proceeds and the account answers for itself.
 */

import { getQuotaObservation, primeQuotaObservation } from "open-sse/services/quotaExhaustion.ts"
import { getUsageForProvider, supportsUsage } from "open-sse/services/usage.ts"
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy"
import * as log from "../utils/logger.ts"
import { primeAntigravityQuotaCache } from "./antigravityQuota.ts"

/** How long a reading is considered current. */
const REFRESH_TTL_MS = 5 * 60_000
/** A quota read may not delay a request for longer than this. */
const FETCH_TIMEOUT_MS = 2_500

const lastAttemptAt = new Map<string, number>()
const inflight = new Map<string, Promise<void>>()

interface QuotaConnection {
	id?: string
	provider?: string
	accessToken?: string
	apiKey?: string
	providerSpecificData?: unknown
	projectId?: string
}

function proxyOptionsOf(config: Record<string, unknown>): Record<string, unknown> {
	return {
		connectionProxyEnabled: config.connectionProxyEnabled === true,
		connectionProxyUrl: config.connectionProxyUrl || "",
		connectionNoProxy: config.connectionNoProxy || "",
		vercelRelayUrl: config.vercelRelayUrl || "",
		strictProxy: config.strictProxy === true,
	}
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
	return Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))])
}

/**
 * Read quota for one connection and record it.
 *
 * `force` skips the TTL gate (used when the operator asks for a refresh).
 */
export async function observeConnectionQuota(
	connection: QuotaConnection,
	options: { force?: boolean } = {},
): Promise<void> {
	const connectionId = connection?.id
	const provider = connection?.provider
	if (!connectionId || !provider || !supportsUsage(provider)) return

	const pending = inflight.get(connectionId)
	if (pending) return pending

	const now = Date.now()
	const last = lastAttemptAt.get(connectionId) || 0
	if (!options.force && now - last < REFRESH_TTL_MS) return

	// Recorded before the call so a slow endpoint cannot be retried by every request in flight.
	lastAttemptAt.set(connectionId, now)

	const run = (async () => {
		try {
			const proxyConfig = await resolveConnectionProxyConfig(
				(connection.providerSpecificData || {}) as Record<string, unknown>,
			)
			const usage = await withTimeout(
				getUsageForProvider(
					{
						provider,
						accessToken: connection.accessToken,
						apiKey: connection.apiKey,
						providerSpecificData: connection.providerSpecificData,
						projectId: connection.projectId,
					} as Parameters<typeof getUsageForProvider>[0],
					proxyOptionsOf(proxyConfig as Record<string, unknown>) as Parameters<
						typeof getUsageForProvider
					>[1],
				),
				FETCH_TIMEOUT_MS,
			)
			if (!usage?.quotas) return
			primeQuotaObservation(connectionId, provider, usage.quotas)
			// Antigravity's filter reads family buckets ("gemini_weekly") rather than model ids,
			// so its own cache needs the same reading.
			if (provider === "antigravity") primeAntigravityQuotaCache(connectionId, usage.quotas)
		} catch (error) {
			log.debug(
				"QUOTA_PREFLIGHT",
				`${connectionId.slice(0, 8)} | ${provider} | read failed: ${String(error)}`,
			)
		} finally {
			inflight.delete(connectionId)
		}
	})()

	inflight.set(connectionId, run)
	return run
}

/**
 * Make sure every candidate connection has a quota observation.
 *
 * Connections that have never been observed are read and awaited — selection is blind without
 * them. Connections with a stale observation are refreshed in the background, so the request
 * uses what we already know instead of waiting for a fresh number.
 */
export async function ensureQuotaObservations(
	connections: readonly QuotaConnection[],
): Promise<void> {
	if (!connections?.length) return

	const cold: Promise<void>[] = []
	for (const connection of connections) {
		if (!connection?.id || !connection.provider || !supportsUsage(connection.provider)) continue
		if (getQuotaObservation(connection.id)) {
			// Warm: refresh without holding up the request.
			void observeConnectionQuota(connection)
			continue
		}
		cold.push(observeConnectionQuota(connection))
	}
	if (cold.length === 0) return
	await Promise.all(cold)
}

/** Forget the throttle state for a connection (tests, and after re-authorization). */
export function resetQuotaPreflight(connectionId?: string): void {
	if (connectionId) {
		lastAttemptAt.delete(connectionId)
		inflight.delete(connectionId)
		return
	}
	lastAttemptAt.clear()
	inflight.clear()
}
