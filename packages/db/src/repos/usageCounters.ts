/**
 * The accumulators behind the usage report.
 *
 * Every bucket in the report — provider, model, account, api key, endpoint — is
 * incremented the same way: create the counter on first sight, add five fields, then
 * keep the newest timestamp. That ceremony was written out eight times across
 * getUsageStats, and the copies had already drifted: some compared timestamps with
 * `new Date(a) > new Date(b)` against an ISO string, others with plain string
 * comparison against a day key, which order the same way only because both are
 * zero-padded ISO prefixes.
 *
 * These functions take the counter and the numbers; the caller decides which bucket
 * key to build. Nothing here reads the DB or knows what a period is.
 */

/** The five numbers every bucket totals. */
export interface UsageTotals {
	requests: number
	promptTokens: number
	completionTokens: number
	cachedTokens: number
	cost: number
}

/** A bucket row: its totals plus whatever the report needs to label it. */
export type Counter = UsageTotals & Record<string, unknown>

export function emptyTotals(): UsageTotals {
	return { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 }
}

/**
 * Add one request's numbers to a counter in place.
 *
 * `requests` defaults to 1 because the history path counts one row as one request,
 * while the daily-rollup path passes a pre-summed count.
 */
export function addToCounter(
	target: UsageTotals,
	add: Partial<UsageTotals> & { requests?: number },
): void {
	target.requests += add.requests ?? 1
	target.promptTokens += add.promptTokens || 0
	target.completionTokens += add.completionTokens || 0
	target.cachedTokens += add.cachedTokens || 0
	target.cost += add.cost || 0
}

/**
 * Get the counter for a key, creating it from `create()` on first sight, then add.
 *
 * Returns the counter so a caller can update `lastUsed` on the same row without a
 * second lookup.
 */
export function accumulate<T extends Counter>(
	map: Record<string, T>,
	key: string,
	create: () => T,
	add: Partial<UsageTotals> & { requests?: number },
): T {
	map[key] ||= create()
	addToCounter(map[key], add)
	return map[key]
}

/**
 * Keep the newest timestamp on a counter.
 *
 * Timestamps arrive as either an ISO datetime (history rows) or a `YYYY-MM-DD` day key
 * (rollup rows). Both are compared as instants so a day key is midnight UTC, and both
 * are zero-padded so a lexicographic comparison would agree — but parsing keeps the
 * comparison correct if a source ever emits a non-UTC offset.
 *
 * A falsy candidate, or a candidate that fails to parse, is ignored: a broken
 * timestamp must not become the newest one and then stick.
 */
export function keepNewest(
	target: Counter,
	field: string,
	candidate: string | null | undefined,
): void {
	if (!candidate) return
	const next = Date.parse(candidate)
	if (Number.isNaN(next)) return
	const current = Date.parse(String(target[field] ?? ""))
	if (Number.isNaN(current) || next > current) target[field] = candidate
}

/**
 * Add up the whole totals block across every bucket.
 *
 * `totalRequests` in the report is derived from the provider buckets rather than
 * counted separately, because a filtered read can drop rows the provider bucket also
 * dropped — counting independently would report requests that are in no bucket.
 */
export function sumTotals(values: Iterable<UsageTotals>): UsageTotals {
	const total = emptyTotals()
	for (const v of values) {
		total.requests += v.requests || 0
		total.promptTokens += v.promptTokens || 0
		total.completionTokens += v.completionTokens || 0
		total.cachedTokens += v.cachedTokens || 0
		total.cost += v.cost || 0
	}
	return total
}
