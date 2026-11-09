/**
 * Day-rollup staging and flush.
 *
 * Extracted verbatim from usageRepo.ts. No behaviour change.
 */

import { getAdapter } from "../driver.ts"
import { parseJson, stringifyJson } from "../helpers/jsonCol.ts"
import { resolvedModelOf } from "../helpers/modelLabel.ts"
import type { DbRow, ResolvedDbAdapter } from "../types.ts"
import {
	apiKeyBucketId,
	CONN_CACHE_TTL_MS,
	type ConnectionMap,
	connCache,
	maskApiKey,
	RING_CAP,
	recentRing,
} from "./usageState.ts"
import type { UsageCounters, UsageDay, UsageEntry, UsageTokens } from "./usageTypes.ts"

export function addToCounter(
	target: UsageCounters,
	key: string,
	values: {
		requests?: number
		promptTokens?: number
		completionTokens?: number
		cachedTokens?: number
		cost?: number
		meta?: Record<string, unknown>
	},
): void {
	target[key] ||= { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 }
	target[key].requests += values.requests || 1
	target[key].promptTokens += values.promptTokens || 0
	target[key].completionTokens += values.completionTokens || 0
	target[key].cachedTokens += values.cachedTokens || 0
	target[key].cost += values.cost || 0
	if (values.meta) {
		const meta: Record<string, unknown> = { ...values.meta }
		for (const k of Object.keys(meta)) if (meta[k] === undefined) delete meta[k]
		Object.assign(target[key], meta)
	}
}

export function aggregateEntryToDay(day: UsageDay, entry: UsageEntry): void {
	const promptTokens = entry.tokens?.prompt_tokens || entry.tokens?.input_tokens || 0
	const completionTokens = entry.tokens?.completion_tokens || entry.tokens?.output_tokens || 0
	const cachedTokens = entry.tokens?.cached_tokens || entry.tokens?.cache_read_input_tokens || 0
	const cost = entry.cost || 0
	const vals = { promptTokens, completionTokens, cachedTokens, cost }

	day.requests = (day.requests || 0) + 1
	day.promptTokens = (day.promptTokens || 0) + promptTokens
	day.completionTokens = (day.completionTokens || 0) + completionTokens
	day.cachedTokens = (day.cachedTokens || 0) + cachedTokens
	day.cost = (day.cost || 0) + cost

	day.byProvider ||= {}
	day.byModel ||= {}
	day.byAccount ||= {}
	day.byApiKey ||= {}
	day.byEndpoint ||= {}

	if (entry.provider) addToCounter(day.byProvider, entry.provider, vals)

	const modelKey = entry.provider ? `${String(entry.model)}|${entry.provider}` : String(entry.model)
	addToCounter(day.byModel, modelKey, {
		...vals,
		meta: { rawModel: entry.model, provider: entry.provider, resolvedModel: entry.resolvedModel },
	})

	if (entry.connectionId) {
		// Keyed by the model as well as the account: an account's usage is reported
		// per model (the dashboard groups these rows by accountName), so collapsing
		// every model into one bucket per account reported the whole account under
		// whichever model happened to write last, with all other models' tokens
		// counted inside it. Meta carries rawModel/provider for the reader.
		const accountKey = `${entry.connectionId}|${String(entry.model)}|${entry.provider || "unknown"}`
		addToCounter(day.byAccount, accountKey, {
			...vals,
			meta: { rawModel: entry.model, provider: entry.provider },
		})
	}

	const apiKeyVal: string =
		entry.apiKey && typeof entry.apiKey === "string" ? entry.apiKey : "local-no-key"
	const akModelKey = `${apiKeyBucketId(String(apiKeyVal))}|${String(entry.model)}|${entry.provider || "unknown"}`
	// `apiKey` here must stay the MASKED form. usageDaily is a persisted,
	// long-lived aggregate, and byApiKey is returned verbatim by
	// GET /api/usage/stats — storing the raw secret put a replayable upstream key
	// on disk and (via the reader's `ak.apiKey` passthrough) on the wire, which is
	// the exposure apiKeyBucketId exists to prevent. The bucket id keeps
	// attribution; the reader resolves names from it.
	addToCounter(day.byApiKey, akModelKey, {
		...vals,
		meta: { rawModel: entry.model, provider: entry.provider, apiKey: maskApiKey(apiKeyVal) },
	})

	const endpoint = entry.endpoint || "Unknown"
	const epKey = `${endpoint}|${String(entry.model)}|${entry.provider || "unknown"}`
	addToCounter(day.byEndpoint, epKey, {
		...vals,
		meta: { endpoint, rawModel: entry.model, provider: entry.provider },
	})
}

// ─── Coalesced day-rollup writer ─────────────────────────────────────────────
//
// `usageDaily` is one JSON blob per day, and the write path used to do a full
// read → JSON.parse → mutate → JSON.stringify → UPSERT for EVERY completed
// request. That is O(blob) per request on a synchronous driver that blocks the
// event loop, so the cost grows with how busy the day was: measured on this
// repo, 245us/request on an empty day but 2.4ms at 210KB and 10.9ms at 1MB
// (parse 24ms + stringify 20ms per write at 4MB). With many concurrent users
// that one hotspot serialises the whole gateway.
//
// Fix: a finished request appends its contribution to `usagePending` — one small
// INSERT, O(1) regardless of how large the day already is — and the blob is
// rewritten once per flush, with every pending row folded in at that point.
//
// This is deliberately NOT an in-memory buffer. Buffering would make the write
// cheap but lose the pending window on every restart, and the gateway is
// restarted by systemd on each deploy. Appending a row keeps the durability the
// per-request write had (the delta is on disk before saveRequestUsage returns)
// while moving the O(blob) work off the request path.
//
// Readers fold any not-yet-flushed rows on top of the blob (flushDayRollup is
// awaited by getUsageStats/getChartData), so a dashboard poll is always exact.
const DAY_FLUSH_INTERVAL_MS = 1000
let dayFlushTimer: NodeJS.Timeout | null = null

export function scheduleDayFlush(): void {
	if (dayFlushTimer) return
	dayFlushTimer = setTimeout(() => {
		dayFlushTimer = null
		flushDayRollup().catch((e) => console.error("[usageRepo] day rollup flush failed:", e.message))
	}, DAY_FLUSH_INTERVAL_MS)
	dayFlushTimer.unref?.()
}

/**
 * Append one entry's contribution to the pending log. Runs inside the caller's
 * transaction, next to the history insert, so both land or neither does.
 */
export function stageDayEntry(db: ResolvedDbAdapter, dateKey: string, entry: UsageEntry): void {
	db.run(`INSERT INTO usagePending(dateKey, entry) VALUES(?, ?)`, [
		dateKey,
		stringifyJson({
			provider: entry.provider || null,
			model: entry.model || null,
			connectionId: entry.connectionId || null,
			apiKey: entry.apiKey || null,
			endpoint: entry.endpoint || null,
			tokens: entry.tokens || {},
			cost: entry.cost || 0,
		}),
	])
	scheduleDayFlush()
}

export function emptyDay(): UsageDay {
	return {
		requests: 0,
		promptTokens: 0,
		completionTokens: 0,
		cost: 0,
		byProvider: {},
		byModel: {},
		byAccount: {},
		byApiKey: {},
		byEndpoint: {},
	}
}

/**
 * Fold every pending row into its day blob, then delete the rows. One
 * transaction, so a crash mid-flush re-folds nothing and loses nothing: either
 * the blob carries the deltas and the rows are gone, or neither happened.
 */
export async function flushDayRollup() {
	const db = await getAdapter()
	const rows = db.all<{ id: number; dateKey: string; entry: string }>(
		`SELECT id, dateKey, entry FROM usagePending ORDER BY id ASC`,
	)
	if (!rows.length) return

	const byDay = new Map<string, UsageEntry[]>()
	for (const row of rows) {
		const parsed = parseJson<UsageEntry | null>(row.entry, null)
		if (!parsed) continue
		if (!byDay.has(row.dateKey)) byDay.set(row.dateKey, [])
		byDay.get(row.dateKey)!.push(parsed)
	}

	db.transaction(() => {
		for (const [dateKey, entries] of byDay) {
			const stored = db.get<{ data: string }>(`SELECT data FROM usageDaily WHERE dateKey = ?`, [
				dateKey,
			])
			const day: UsageDay = stored ? parseJson<UsageDay>(stored.data, emptyDay()) : emptyDay()
			for (const entry of entries) aggregateEntryToDay(day, entry)
			db.run(
				`INSERT INTO usageDaily(dateKey, data) VALUES(?, ?) ON CONFLICT(dateKey) DO UPDATE SET data = excluded.data`,
				[dateKey, stringifyJson(day)],
			)
		}
		// Only the rows this flush actually folded. A row inserted while the merge
		// above was running has a higher id and stays pending for the next flush.
		const lastId = rows[rows.length - 1].id
		db.run(`DELETE FROM usagePending WHERE id <= ?`, [lastId])
	})
}

// Flush before serving a reader, so the dashboard never reports a rollup that is
// missing the last second of traffic.
export async function flushDayRollupQuietly() {
	try {
		await flushDayRollup()
	} catch {
		/* the reader still serves the last persisted rollup */
	}
}

export async function getConnectionMapCached(): Promise<ConnectionMap> {
	if (Date.now() - connCache.ts < CONN_CACHE_TTL_MS) return connCache.map
	try {
		const { getProviderConnections } = await import("./connectionsRepo.ts")
		const all = await getProviderConnections()
		const map: ConnectionMap = {}
		for (const c of all) if (c) map[c.id] = c.name || c.email || c.id
		connCache.map = map
		connCache.ts = Date.now()
	} catch (e) {
		// Leave the cache empty rather than stale: a usage row then shows no connection
		// name, which reads as "unknown" instead of naming the wrong one.
		console.error("[usage] failed to load connection names:", e)
	}
	return connCache.map
}

export async function ensureRingInitialized() {
	if (recentRing.initialized) return
	recentRing.initialized = true
	try {
		const db = await getAdapter()
		const rows = db.all<DbRow>(
			`SELECT timestamp, provider, model, connectionId, apiKey, endpoint, cost, status, tokens, meta FROM usageHistory ORDER BY id DESC LIMIT ?`,
			[RING_CAP],
		)
		recentRing.items = rows.reverse().map(
			(r): UsageEntry => ({
				timestamp: String(r.timestamp),
				provider: (r.provider as string | null) ?? null,
				model: (r.model as string | null) ?? null,
				// The `model` column holds the name the caller asked for (a combo name
				// survives there); the real target rides along in meta. Resolving it here
				// keeps the live stream honest after a restart instead of showing the combo.
				resolvedModel: resolvedModelOf(r.meta),
				connectionId: (r.connectionId as string | null) ?? null,
				apiKey: (r.apiKey as string | null) ?? null,
				endpoint: (r.endpoint as string | null) ?? null,
				cost: Number(r.cost) || 0,
				status: (r.status as string | null) ?? null,
				tokens: parseJson<UsageTokens>(r.tokens as string | null, {}),
			}),
		)
	} catch (e) {
		// The ring is a warm-up cache; an empty one costs a query per read, not correctness.
		console.error("[usage] failed to prefill the recent-request ring:", e)
	}
}

export async function calculateCost(
	provider: string | null | undefined,
	model: string | null | undefined,
	tokens: UsageTokens | null | undefined,
): Promise<number> {
	if (!tokens || !provider || !model) return 0
	try {
		const { getPricingForModel } = await import("./pricingRepo.ts")
		const pricing = await getPricingForModel(provider, model)
		if (!pricing) return 0

		// Delegate the actual math to the single source of truth (avoids the two
		// copies drifting apart - see open-sse/providers/pricing.js for the
		// cache-inclusive prompt_tokens convention this assumes).
		const { calculateCostFromTokens } = await import("@9router/pricing")
		return calculateCostFromTokens(tokens, pricing)
	} catch (e) {
		console.error("Error calculating cost:", e)
		return 0
	}
}
