/**
 * In-process health of each provider account: recent success rate and latency.
 *
 * Why memory and not the database: this is read on the *hot path*, once per candidate account
 * per request, and the selection runs before any upstream call. A query there would add a
 * round-trip to every request to answer a question whose value decays in minutes. The trade-off
 * is stated plainly — the numbers restart with the process, so the first few requests after a
 * restart see neutral scores and the order falls back to priority. That is the correct failure
 * mode: a restart should not invent an opinion.
 *
 * The ring is bounded per account (`HEALTH_RING`) so a long-lived process cannot grow with
 * traffic, and the p95 is computed exactly from the ring rather than approximated by an average
 * — a mean hides the tail, and the tail is what a user feels.
 *
 * Recording is best-effort and never throws: a request must not fail because its health sample
 * could not be filed.
 */
import {
	HEALTH_MIN_SAMPLES,
	type HealthStats,
	healthScore,
	type RankableAccount,
	rankByHealth,
} from "9router-api/domain/connection-health"

/** How many recent requests per account the p95 is computed from. */
const HEALTH_RING = 50

interface AccountHealth {
	/** Recent outcomes, `1` for success and `0` for failure. */
	readonly outcomes: number[]
	/** Recent total durations in milliseconds. */
	readonly latencies: number[]
}

const registry = new Map<string, AccountHealth>()

function bucketOf(connectionId: string): AccountHealth {
	const existing = registry.get(connectionId)
	if (existing) return existing
	const created: AccountHealth = { outcomes: [], latencies: [] }
	registry.set(connectionId, created)
	return created
}

function pushBounded(list: number[], value: number): void {
	list.push(value)
	if (list.length > HEALTH_RING) list.shift()
}

/** The p-th percentile of a small series, by nearest rank. */
function percentileOf(values: readonly number[], p: number): number | null {
	if (values.length === 0) return null
	const sorted = [...values].sort((a, b) => a - b)
	const rank = Math.ceil(Math.min(1, Math.max(0, p)) * sorted.length)
	return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? null
}

/**
 * File one finished request against an account.
 *
 * `ok` is the request's own verdict, not the HTTP status of the upstream: a 429 that the
 * fallback recovered from is still a failed attempt *for that account*, which is exactly what
 * the next selection needs to know.
 */
export function recordConnectionOutcome(input: {
	readonly connectionId?: string | null
	readonly ok: boolean
	readonly latencyMs?: number | null
}): void {
	const connectionId = input.connectionId ? String(input.connectionId) : ""
	if (!connectionId) return
	try {
		const bucket = bucketOf(connectionId)
		pushBounded(bucket.outcomes, input.ok ? 1 : 0)
		if (typeof input.latencyMs === "number" && Number.isFinite(input.latencyMs)) {
			pushBounded(bucket.latencies, Math.max(0, input.latencyMs))
		}
	} catch {
		// A health sample is never worth failing a request over.
	}
}

/** What is known about one account, or `null` when it has no history. */
export function connectionHealthStats(connectionId: string): HealthStats | null {
	const bucket = registry.get(connectionId)
	if (!bucket || bucket.outcomes.length === 0) return null
	const successes = bucket.outcomes.reduce((sum, value) => sum + value, 0)
	return {
		samples: bucket.outcomes.length,
		successRate: successes / bucket.outcomes.length,
		p95LatencyMs: percentileOf(bucket.latencies, 0.95),
	}
}

/** The score an account would get right now, for diagnostics and tests. */
export function connectionHealthScore(
	connectionId: string,
	pool: readonly RankableAccount[],
): number {
	const fastest = fastestP95(pool)
	return healthScore(connectionHealthStats(connectionId), fastest)
}

function fastestP95(pool: readonly RankableAccount[]): number | null {
	let fastest: number | null = null
	for (const account of pool) {
		const stats = connectionHealthStats(account.id)
		if (!stats || stats.samples < HEALTH_MIN_SAMPLES) continue
		const p95 = stats.p95LatencyMs
		if (p95 === null || p95 <= 0) continue
		if (fastest === null || p95 < fastest) fastest = p95
	}
	return fastest
}

/**
 * Reorder the candidates for selection: priority tiers keep their order, and inside a tier the
 * healthier account comes first. See `domain/connection-health.ts` for the rules.
 */
export function rankConnectionsByHealth<T extends RankableAccount>(accounts: readonly T[]): T[] {
	if (accounts.length < 2) return [...accounts]
	return rankByHealth(accounts, connectionHealthStats)
}

/** Drop all history. Used by tests, and by the "reset health" control. */
export function resetConnectionHealth(): void {
	registry.clear()
}

/** A snapshot for diagnostics: one row per account with history. */
export function connectionHealthSnapshot(): Array<{
	connectionId: string
	samples: number
	successRate: number
	p95LatencyMs: number | null
}> {
	return [...registry.keys()].map((connectionId) => {
		const stats = connectionHealthStats(connectionId)
		return {
			connectionId,
			samples: stats?.samples ?? 0,
			successRate: stats?.successRate ?? 0,
			p95LatencyMs: stats?.p95LatencyMs ?? null,
		}
	})
}
