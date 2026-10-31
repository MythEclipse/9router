/**
 * Choosing between two accounts that are both healthy.
 *
 * The pool already knows which accounts are *unavailable* — a cooldown, a model lock, an
 * exhausted quota — and it skips those. What it could not do was prefer the account that is
 * answering in 900 ms over the one answering in 6 s, or notice that one of them fails a third
 * of the time. Both facts were being measured on every request and thrown away.
 *
 * The rule below is deliberately conservative, because a routing change is the kind of thing
 * that silently doubles someone's bill:
 *
 * 1. **Priority is the operator's intent and outranks telemetry.** Health only reorders
 *    accounts *within* one priority tier. An operator who put an account first meant it; a
 *    gateway that quietly overrules that on the strength of twenty requests is not routing, it
 *    is second-guessing.
 * 2. **No samples is neutral, not bad.** A freshly imported account has no history and must not
 *    be pushed behind a mediocre one just because it is new.
 * 3. **A handful of samples is not evidence.** Below `HEALTH_MIN_SAMPLES` the score stays
 *    neutral, so a single slow request cannot demote an account for the rest of the day.
 * 4. **Latency is scored relative to the pool.** Comparing a provider's absolute p95 against a
 *    fixed number punishes every account on a slow upstream and rewards none; what matters is
 *    which of *these* accounts is faster.
 * 5. **Success rate dominates.** A fast account that fails is worth less than a slower one that
 *    answers, so speed contributes at most `SPEED_WEIGHT` of the score.
 */

/** Samples an account needs before its health may move it in the order. */
export const HEALTH_MIN_SAMPLES = 5

/** How much of the score speed may contribute. The rest is success rate. */
export const SPEED_WEIGHT = 0.3

/** What a neutral (unknown) account scores: the middle, so it wins no tie-break and loses none. */
export const NEUTRAL_HEALTH_SCORE = 0.5

/** What the router knows about one account's recent behaviour. */
export interface HealthStats {
	readonly samples: number
	/** Share of completed requests that succeeded, in `[0, 1]`. */
	readonly successRate: number
	/** Recent p95 in milliseconds, or `null` when nothing has been timed. */
	readonly p95LatencyMs: number | null
}

/** One candidate, as the ranking reads it. */
export interface RankableAccount {
	readonly id: string
	readonly priority?: number | null
}

function clamp(value: number, low: number, high: number): number {
	return Math.min(high, Math.max(low, value))
}

/**
 * Score one account against the pool's fastest.
 *
 * `fastestP95` is the smallest p95 among accounts with enough samples. An account with no
 * timing of its own scores as if it were average rather than as if it were instant.
 */
export function healthScore(stats: HealthStats | null, fastestP95: number | null): number {
	if (!stats || stats.samples < HEALTH_MIN_SAMPLES) return NEUTRAL_HEALTH_SCORE
	const success = clamp(stats.successRate, 0, 1)
	const own = stats.p95LatencyMs
	if (own === null || fastestP95 === null || own <= 0 || fastestP95 <= 0) {
		return clamp(success, 0, 1)
	}
	const speed = clamp(fastestP95 / own, 0, 1)
	return clamp(success * (1 - SPEED_WEIGHT) + speed * SPEED_WEIGHT, 0, 1)
}

/** The fastest p95 in the pool, or `null` when nobody has been timed. */
export function fastestP95Of(
	accounts: readonly RankableAccount[],
	statsOf: (id: string) => HealthStats | null,
): number | null {
	let fastest: number | null = null
	for (const account of accounts) {
		const stats = statsOf(account.id)
		if (!stats || stats.samples < HEALTH_MIN_SAMPLES) continue
		const p95 = stats.p95LatencyMs
		if (p95 === null || p95 <= 0) continue
		if (fastest === null || p95 < fastest) fastest = p95
	}
	return fastest
}

/**
 * Reorder candidates: priority tiers stay in their stored order, and within a tier the healthier
 * account comes first. Ties keep the caller's order, so an install with no measurements gets
 * exactly the list it passed in.
 *
 * The sort is stable by construction (index carried through), because an unstable sort would
 * shuffle equal accounts on every request — the opposite of what a deterministic router should
 * do.
 */
export function rankByHealth<T extends RankableAccount>(
	accounts: readonly T[],
	statsOf: (id: string) => HealthStats | null,
): T[] {
	if (accounts.length < 2) return [...accounts]
	const fastest = fastestP95Of(accounts, statsOf)
	const scored = accounts.map((account, index) => ({
		account,
		index,
		priority: typeof account.priority === "number" ? account.priority : 999,
		score: healthScore(statsOf(account.id), fastest),
	}))
	scored.sort((a, b) => a.priority - b.priority || b.score - a.score || a.index - b.index)
	return scored.map((entry) => entry.account)
}
