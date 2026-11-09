/**
 * Recent-request accumulation helpers.
 *
 * Extracted verbatim from usageRepo.ts.
 */

import { parseJson, stringifyJson } from "../helpers/jsonCol.ts"
import { labelForRow, resolvedModelOf } from "../helpers/modelLabel.ts"
import type { DbRow, ResolvedDbAdapter } from "../types.ts"

import { accumulate, emptyTotals, keepNewest, type UsageTotals } from "./usageCounters.ts"
import { aggregateEntryToDay, emptyDay } from "./usageDayRollup.ts"
import type { ProviderNodeNameMap } from "./usageLookups.ts"
import { type ConnectionMap, maskApiKey, PERIOD_MS } from "./usageState.ts"
import type {
	UsageBucket,
	UsageCounter,
	UsageDay,
	UsageEntry,
	UsageStats,
	UsageTokens,
} from "./usageTypes.ts"

export function loadDaysInRange(
	adapter: ResolvedDbAdapter,
	maxDays: number | null,
): Array<{ dateKey: string; data: string }> {
	if (maxDays == null) {
		return adapter.all<{ dateKey: string; data: string }>(
			`SELECT dateKey, data FROM usageDaily ORDER BY dateKey ASC`,
		)
	}
	const today = new Date()
	const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - maxDays + 1)
	const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`
	return adapter.all<{ dateKey: string; data: string }>(
		`SELECT dateKey, data FROM usageDaily WHERE dateKey >= ? ORDER BY dateKey ASC`,
		[cutoffKey],
	)
}

/**
 * Fold pending day-rollup rows into the `usageDaily` blob before reading it, so
 * the dashboard never reports a rollup missing the latest saved usage.
 *
 * Runs on the caller's already-open handle: opening a second one would take a
 * savepoint that conflicts with concurrent migrations under the sql.js adapter.
 */
export function foldPendingRollupRows(adapter: ResolvedDbAdapter): void {
	const pendingRows =
		adapter.all<{ dateKey: string; entry: string }>(
			`SELECT dateKey, entry FROM usagePending ORDER BY id ASC`,
		) || []
	for (const row of pendingRows) {
		const parsed = parseJson<UsageEntry | null>(row.entry, null)
		if (!parsed) continue
		const stored = adapter.get<{ data: string }>(`SELECT data FROM usageDaily WHERE dateKey = ?`, [
			row.dateKey,
		])
		const day: UsageDay = stored ? parseJson<UsageDay>(stored.data, emptyDay()) : emptyDay()
		aggregateEntryToDay(day, parsed)
		adapter.run(
			`INSERT INTO usageDaily(dateKey, data) VALUES(?, ?) ON CONFLICT(dateKey) DO UPDATE SET data = excluded.data`,
			[row.dateKey, stringifyJson(day)],
		)
	}
	if (pendingRows.length) adapter.run(`DELETE FROM usagePending`)
}

/**
 * Fill the 10 one-minute buckets ending at the current minute.
 *
 * The buckets are pre-seeded so a quiet minute renders as zero rather than a gap,
 * then billed rows inside the window are summed into them.
 */
export function buildLastTenMinutes(
	adapter: ResolvedDbAdapter,
	filterApiKey: string | null,
	modelAllowed: (model: string) => boolean,
): UsageBucket[] {
	const now = new Date()
	const currentMinuteStart = new Date(Math.floor(now.getTime() / 60000) * 60000)
	const tenMinutesAgo = new Date(currentMinuteStart.getTime() - 9 * 60 * 1000)

	const buckets: UsageBucket[] = []
	const bucketMap: Record<number, UsageBucket> = {}
	for (let i = 0; i < 10; i++) {
		const ts = currentMinuteStart.getTime() - (9 - i) * 60 * 1000
		bucketMap[ts] = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 }
		buckets.push(bucketMap[ts])
	}

	const sql = filterApiKey
		? `SELECT timestamp, model, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ? AND timestamp <= ? AND apiKey = ? AND status = 'ok'`
		: `SELECT timestamp, model, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ? AND timestamp <= ? AND status = 'ok'`
	const params = filterApiKey
		? [tenMinutesAgo.toISOString(), now.toISOString(), filterApiKey]
		: [tenMinutesAgo.toISOString(), now.toISOString()]

	for (const r of adapter.all<DbRow>(sql, params)) {
		if (!modelAllowed(String(r.model ?? ""))) continue
		const minuteStart = Math.floor(new Date(String(r.timestamp)).getTime() / 60000) * 60000
		const bucket = bucketMap[minuteStart]
		if (!bucket) continue
		bucket.requests++
		bucket.promptTokens += Number(r.promptTokens) || 0
		bucket.completionTokens += Number(r.completionTokens) || 0
		bucket.cost += Number(r.cost) || 0
	}
	return buckets
}

/**
 * ISO cutoff for a period, or null for unbounded ("all").
 * `today` means local midnight, so it cannot be derived from PERIOD_MS.
 */
export function periodCutoff(period: string): string | null {
	if (period === "today") {
		const startOfDay = new Date()
		startOfDay.setHours(0, 0, 0, 0)
		return startOfDay.toISOString()
	}
	const span = PERIOD_MS[String(period)]
	return span ? new Date(Date.now() - span).toISOString() : null
}

/** Shape of a usage row as this file's queries select it. */

export function addFlatTotals(stats: UsageStats, add: Partial<UsageTotals>): void {
	stats.totalPromptTokens += add.promptTokens || 0
	stats.totalCompletionTokens += add.completionTokens || 0
	stats.totalCachedTokens += add.cachedTokens || 0
	stats.totalCost += add.cost || 0
}

interface BucketRowKeys {
	connectionMap: ConnectionMap
	providerNodeNameMap: ProviderNodeNameMap
	apiKeyMap: Record<string, { name?: string } | undefined>
}

export type CounterRow = UsageCounter & Record<string, unknown>

export function accumulateHistoryRow(
	buckets: UsageStats,
	row: DbRow,
	{ connectionMap, providerNodeNameMap, apiKeyMap }: BucketRowKeys,
	opts: { includeUnkeyedRows: boolean },
): void {
	const rawProvider = String(row.provider ?? "")
	const providerName = providerNodeNameMap[rawProvider] || rawProvider
	const rawModel = String(row.model ?? "")
	const rawTimestamp = String(row.timestamp ?? "")
	const rawApiKey = String(row.apiKey ?? "")
	const connectionId = row.connectionId ? String(row.connectionId) : null
	const tokens = parseJson<UsageTokens>(row.tokens as string | null, {})
	const promptTokens = Number(row.promptTokens) || tokens.prompt_tokens || tokens.input_tokens || 0
	const completionTokens =
		Number(row.completionTokens) || tokens.completion_tokens || tokens.output_tokens || 0
	const add = {
		promptTokens,
		completionTokens,
		cachedTokens: tokens.cached_tokens || tokens.cache_read_input_tokens || 0,
		cost: Number(row.cost) || 0,
	}

	addFlatTotals(buckets, add)
	accumulate(buckets.byProvider, rawProvider, () => ({ ...emptyTotals() }), add)

	const modelKey = rawProvider ? `${rawModel} (${rawProvider})` : rawModel
	const modelRow = accumulate(
		buckets.byModel as Record<string, CounterRow>,
		modelKey,
		() => ({
			...emptyTotals(),
			rawModel,
			provider: providerName,
			resolvedModel: resolvedModelOf(row.meta) ?? undefined,
			lastUsed: rawTimestamp,
		}),
		add,
	)
	keepNewest(modelRow, "lastUsed", rawTimestamp)

	if (connectionId) {
		const accountName = connectionMap[connectionId] || `Account ${connectionId.slice(0, 8)}...`
		const accountKey = `${rawModel} (${rawProvider} - ${accountName})`
		const accountRow = accumulate(
			buckets.byAccount as Record<string, CounterRow>,
			accountKey,
			() => ({
				...emptyTotals(),
				rawModel,
				provider: providerName,
				connectionId,
				accountName,
				lastUsed: rawTimestamp,
			}),
			add,
		)
		keepNewest(accountRow, "lastUsed", rawTimestamp)
	}

	// The two views key a keyless row differently, and that difference is load-bearing:
	// a single key's report falls through here with an empty key (it filtered by key, so
	// the column is authoritative) and lands under `<null>|model|provider`; the live view
	// groups every keyless row under one visible "local-no-key" bucket instead.
	if (rawApiKey || !opts.includeUnkeyedRows) {
		const apiKeyMasked = maskApiKey(rawApiKey)
		const keyRow = accumulate(
			buckets.byApiKey as Record<string, CounterRow>,
			`${apiKeyMasked}|${rawModel}|${rawProvider || "unknown"}`,
			(): CounterRow => ({
				...emptyTotals(),
				rawModel,
				provider: providerName,
				apiKeyMasked,
				keyName: apiKeyMap[rawApiKey]?.name || rawApiKey.slice(0, 8) + "...",
				apiKeyKey: apiKeyMasked ?? undefined,
				lastUsed: rawTimestamp,
			}),
			add,
		)
		keepNewest(keyRow, "lastUsed", rawTimestamp)
	} else {
		const keyRow = accumulate(
			buckets.byApiKey as Record<string, CounterRow>,
			"local-no-key",
			(): CounterRow => ({
				...emptyTotals(),
				rawModel,
				provider: providerName,
				apiKeyMasked: null,
				keyName: "Local (No API Key)",
				apiKeyKey: "local-no-key",
				lastUsed: rawTimestamp,
			}),
			add,
		)
		keepNewest(keyRow, "lastUsed", rawTimestamp)
	}

	const endpoint = String(row.endpoint ?? "") || "Unknown"
	const epKey = `${endpoint}|${rawModel}|${rawProvider || "unknown"}`
	const epRow = accumulate(
		buckets.byEndpoint as Record<string, CounterRow>,
		epKey,
		() => ({ ...emptyTotals(), endpoint, rawModel, provider: providerName, lastUsed: rawTimestamp }),
		add,
	)
	keepNewest(epRow, "lastUsed", rawTimestamp)
}
