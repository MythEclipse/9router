/**
 * The per-key usage report's arithmetic.
 *
 * `/api/usage/api-keys` answers one row per API key: quota state plus aggregates
 * from `usageHistory`. Three of its steps are rules rather than queries, and each
 * one had a defensible-looking implementation that was wrong:
 *
 * **Which token count is the truth.** The `apiKeys.usedTokens` column is what
 * `validateApiKey` enforces against. `usageHistory` is a *pruned* log, so after
 * cleanup the window sum reads lower than what was actually spent. Taking the log
 * sum would show a key with room it does not have — the dashboard would say "72%
 * used" while the 429 fires. But taking the column alone is wrong in the other
 * direction: rows can race in before the quota update lands. So the answer is
 * `max(column, windowSum)`, and *why* matters more than the one line.
 *
 * **When the quota window rolls over.** `nextResetAt` is derived from the interval
 * and an anchor; walking forward from the anchor in steps handles a key that has
 * been idle for many windows, which `anchor + span` alone does not — it would
 * report a reset time in the past.
 *
 * **Orphaned usage.** History for keys that no longer exist is only meaningful
 * when listing every key. An API-key session sees its own row and nothing else, so
 * an "orphan" there is not a deleted key, it is a row the session may not read.
 */

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/** How far each reset interval reaches, in ms. `never` (and anything unknown) is open-ended. */
export function resetIntervalMs(resetInterval: unknown): number {
	switch (resetInterval) {
		case "5h":
			return 5 * HOUR_MS
		case "10h":
			return 10 * HOUR_MS
		case "24h":
		case "1d":
			return DAY_MS
		case "7d":
			return 7 * DAY_MS
		case "14d":
			return 14 * DAY_MS
		case "30d":
			return 30 * DAY_MS
		default:
			return 0
	}
}

/**
 * The earliest timestamp a quota window still counts, as an ISO string.
 *
 * An open-ended interval (`never`, or a value this build does not know) counts
 * everything, which is why the floor is year zero rather than `now`: a key with no
 * reset interval has not reset, and treating it as "reset just now" would report
 * zero used tokens for a key that is over its cap.
 */
export function quotaWindowStart(resetInterval: unknown, now: number): string {
	const span = resetIntervalMs(resetInterval)
	return span ? new Date(now - span).toISOString() : "0000-01-01T00:00:00.000Z"
}

/**
 * When the running quota window next rolls over.
 *
 * Returns null for an open-ended interval, and for a key that has never reset —
 * there is no window to roll over, and inventing `now + span` would show a
 * countdown for a quota that does not reset.
 */
export function nextResetAt(
	resetInterval: unknown,
	lastResetAt: unknown,
	now: number,
): string | null {
	const span = resetIntervalMs(resetInterval)
	if (!span) return null

	const anchor = lastResetAt ? new Date(String(lastResetAt)).getTime() : 0
	if (!Number.isFinite(anchor) || anchor <= 0) return null

	// Step forward past now: a key idle for three windows is due at the next multiple,
	// not at `anchor + span`, which is in the past.
	const windowsElapsed = Math.floor((now - anchor) / span)
	const due = anchor + (windowsElapsed + 1) * span
	return new Date(due).toISOString()
}

/**
 * The token count the quota is measured against, and where it came from.
 *
 * `source` is reported so the report can explain a number that disagrees with the
 * log view. Without it, an operator comparing the two pages has no way to learn
 * that pruning is why they differ.
 */
export function resolvedUsedTokens(input: {
	readonly columnValue: unknown
	readonly windowSum: unknown
}): { readonly used: number; readonly source: "column" | "window" | "equal" } {
	const column = Number(input.columnValue) || 0
	const window = Number(input.windowSum) || 0
	if (column > window) return { used: column, source: "column" }
	if (window > column) return { used: window, source: "window" }
	return { used: column, source: "equal" }
}

/** One row of the response, as far as the arithmetic depends on it. */
interface AggregateRow {
	readonly requests?: unknown
	readonly promptTokens?: unknown
	readonly completionTokens?: unknown
	readonly cost?: unknown
	readonly lastUsed?: string | null
}

/** A model row as the store reports it (loose: the value comes from SQL). */
interface ModelRow {
	readonly model?: string | null
	readonly requests?: unknown
	readonly tokens?: unknown
	readonly cost?: unknown
	readonly lastUsed?: string | null
}

/** A model row as the report emits it. */
export interface MergedModelRow {
	readonly model: string
	readonly requests: number
	readonly tokens: number
	readonly cost: number
	readonly lastUsed: string | null
}

/** The per-model rows a key's detail panel shows. */
export const KEY_REPORT_MODEL_LIMIT = 8

function newest(a: string | null | undefined, b: string | null | undefined): string | null {
	if (!a) return b ?? null
	if (!b) return b ?? null
	return a > b ? a : b
}

/**
 * Sums every orphaned key's aggregates into the single "Deleted keys" row.
 *
 * Models are merged by name, because the same model can appear under several
 * deleted keys and showing it three times would misreport its traffic. The merged
 * list is ordered by request count and cut to the same limit as a live key's list,
 * so the row renders in the same panel.
 */
export function mergeOrphanUsage(
	orphanKeys: readonly string[],
	totals: Readonly<Record<string, AggregateRow>>,
	statusByKey: Readonly<Record<string, { readonly ok: number; readonly errors: number }>>,
	modelsByKey: Readonly<Record<string, readonly ModelRow[]>>,
): {
	requests: number
	promptTokens: number
	completionTokens: number
	cost: number
	lastUsed: string | null
	ok: number
	errors: number
	models: readonly MergedModelRow[]
} {
	let requests = 0
	let promptTokens = 0
	let completionTokens = 0
	let cost = 0
	let lastUsed: string | null = null
	let ok = 0
	let errors = 0
	// Mutable accumulator; the emitted rows are `MergedModelRow` (read-only) below.
	const models = new Map<
		string,
		{ model: string; requests: number; tokens: number; cost: number; lastUsed: string | null }
	>()

	for (const raw of orphanKeys) {
		const total = totals[raw]
		if (total) {
			requests += Number(total.requests) || 0
			promptTokens += Number(total.promptTokens) || 0
			completionTokens += Number(total.completionTokens) || 0
			cost += Number(total.cost) || 0
			lastUsed = newest(lastUsed, total.lastUsed)
		}

		const status = statusByKey[raw]
		if (status) {
			ok += status.ok
			errors += status.errors
		}

		for (const row of modelsByKey[raw] ?? []) {
			const name = row.model || "unknown"
			const seen = models.get(name) ?? { model: name, requests: 0, tokens: 0, cost: 0, lastUsed: null }
			seen.requests += Number(row.requests) || 0
			seen.tokens += Number(row.tokens) || 0
			seen.cost += Number(row.cost) || 0
			seen.lastUsed = newest(seen.lastUsed, row.lastUsed)
			models.set(name, seen)
		}
	}

	return {
		requests,
		promptTokens,
		completionTokens,
		cost,
		lastUsed,
		ok,
		errors,
		models: [...models.values()]
			.sort((a, b) => b.requests - a.requests)
			.slice(0, KEY_REPORT_MODEL_LIMIT),
	}
}

/**
 * Whether this session should see the "Deleted keys" row at all.
 *
 * Only a full listing can: with an API-key filter applied, every history row
 * belongs to either the session's own key or to keys it cannot see, and calling
 * those "deleted" would report another branch's traffic under a name that says it
 * is safe to delete.
 */
export function shouldReportOrphanUsage(apiKeyFilter: string | null): boolean {
	return apiKeyFilter === null
}

/** Percent of a cap used, capped at 100, or null when there is no cap. */
export function percentOfCap(used: number, cap: number): number | null {
	if (cap <= 0) return null
	return Math.min(100, (used / cap) * 100)
}

/**
 * The error rate as a fraction in `[0, 1]`.
 *
 * Neither count alone tells the reader anything: 5 errors is fine out of 10 000 and
 * alarming out of 6. A key with no traffic has no rate, so it reports 0 rather than
 * dividing by zero into `NaN`.
 */
export function errorRateOf(ok: number, errors: number): number {
	const total = ok + errors
	return total > 0 ? errors / total : 0
}

/**
 * Newest-used first, then by name.
 *
 * The name tiebreak is what keeps the table from reshuffling between polls: many
 * keys share a `lastUsed` of null, and without it their order is whatever the
 * database happened to return.
 */
export function compareKeyReportRows(
	a: { readonly lastUsed: string | null; readonly name: string },
	b: { readonly lastUsed: string | null; readonly name: string },
): number {
	const byUse = (b.lastUsed || "").localeCompare(a.lastUsed || "")
	return byUse !== 0 ? byUse : a.name.localeCompare(b.name)
}
