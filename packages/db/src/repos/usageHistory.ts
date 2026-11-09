/**
 * Usage write path and history reads.
 *
 * Extracted verbatim from usageRepo.ts.
 */

import { getAdapter } from "../driver.ts"
import { parseJson, stringifyJson } from "../helpers/jsonCol.ts"
import { labelForRow, resolvedModelOf } from "../helpers/modelLabel.ts"
import type { DbRow, ResolvedDbAdapter } from "../types.ts"

import { matchesAllowedModels as matchesModelPatterns, parseAllowedModels } from "./apiKeysRepo.ts"
import { calculateCost, stageDayEntry } from "./usageDayRollup.ts"
import { clearPendingRow } from "./usageLogs.ts"
import { buildApiKeyMaps } from "./usageLookups.ts"
import {
	apiKeyBucketId,
	getLocalDateKey,
	maskApiKey,
	measuredOf,
	pushToRing,
	recentRing,
	scheduleStatsEvent,
	statsEmitter,
} from "./usageState.ts"
import type {
	UsageEntry,
	UsageHistoryFilter,
	UsageHistoryRecord,
	UsageTokens,
} from "./usageTypes.ts"

const HISTORY_RETENTION_MS = 90 * 86400000
const HISTORY_PRUNE_INTERVAL_MS = 3600000
let lastHistoryPruneAt = 0

function pruneHistory(db: ResolvedDbAdapter): void {
	const now = Date.now()
	if (now - lastHistoryPruneAt < HISTORY_PRUNE_INTERVAL_MS) return
	lastHistoryPruneAt = now
	try {
		db.run(`DELETE FROM usageHistory WHERE timestamp < ?`, [
			new Date(now - HISTORY_RETENTION_MS).toISOString(),
		])
	} catch {
		/* pruning must never fail a usage write */
	}
}

// Test seam: the hourly throttle would otherwise make the prune untestable
// within one process (only the first call in a run ever prunes).
export const __test__ = {
	resetHistoryPruneThrottle() {
		lastHistoryPruneAt = 0
	},
	HISTORY_RETENTION_MS,
	/** Pinned by tests: the digest the write path stamps into usageDaily. */
	apiKeyBucketId,
}

export async function saveRequestUsage(
	entry: UsageEntry,
	options: { logOnly?: boolean; allowDuplicate?: boolean } = {},
): Promise<void> {
	// Lifecycle rows (pending/error) exist for the Request Logs view only. They
	// are NOT usage: a request that was billed nothing must not move token, cost
	// or lifetime-counter totals, so logOnly writes usageHistory alone.
	const logOnly = options.logOnly === true
	const allowDuplicate = options.allowDuplicate === true || logOnly
	try {
		const db = await getAdapter()

		if (!entry.timestamp) entry.timestamp = new Date().toISOString()
		entry.cost = logOnly ? 0 : await calculateCost(entry.provider, entry.model, entry.tokens)

		// Cost is priced from the REAL model + provider; the flip below only changes
		// what the dashboards display, never what is billed.
		const resolvedModel = entry.model
		if (entry.requestedModel) entry.model = String(entry.requestedModel)
		entry.resolvedModel = entry.requestedModel ? resolvedModel : undefined

		const tokens = entry.tokens || {}
		const promptTokens = tokens.prompt_tokens || tokens.input_tokens || 0
		const completionTokens = tokens.completion_tokens || tokens.output_tokens || 0

		let inserted = false

		// All writes (history insert, daily upsert, lifetime counter) in ONE transaction.
		// better-sqlite3 is sync → no JS yield mid-transaction → no race in same process.
		db.transaction(() => {
			// A terminal write closes the request's open PENDING marker, so one
			// request is one log row rather than a start row plus an end row.
			if (entry.status !== "pending") {
				clearPendingRow(db, entry)
			}

			// Dedupe protects against ONE request being reported twice.
			//
			// With an explicit requestId we key on that — the only thing that can
			// actually identify a request, since every caller stamps its own
			// `new Date().toISOString()` and two reports of the same call are always
			// milliseconds apart. Without one we keep the historical byte-identical
			// key (timestamp+model+counts) so untagged callers behave exactly as
			// before.
			//
			// The id path exists because that legacy key is also a collision: two
			// DISTINCT requests that land on the same millisecond with equal token
			// counts (a burst of identical prompts on one key) matched it and one was
			// silently dropped. Callers in the chat path always supply an id now.
			//
			// The id is looked up from `requestIdIdx` (an indexed column), NOT from
			// `meta LIKE '%…%'`: that LIKE is a full table scan with no index it can
			// use, and measured 669us/write at 8k rows versus 6us for an indexed
			// lookup — on the per-request hot path.
			if (!allowDuplicate) {
				const existing = entry.requestId
					? db.get(
							`SELECT id, endpoint FROM usageHistory
               WHERE requestId = ?
               ORDER BY id DESC LIMIT 1`,
							[String(entry.requestId)],
						)
					: db.get(
							`SELECT id, endpoint FROM usageHistory
               WHERE timestamp = ?
                 AND COALESCE(provider, '') = COALESCE(?, '')
                 AND COALESCE(model, '') = COALESCE(?, '')
                 AND COALESCE(connectionId, '') = COALESCE(?, '')
                 AND COALESCE(apiKey, '') = COALESCE(?, '')
                 AND promptTokens = ?
                 AND completionTokens = ?
               ORDER BY id DESC LIMIT 1`,
							[
								entry.timestamp,
								entry.provider || null,
								entry.model || null,
								entry.connectionId || null,
								entry.apiKey || null,
								promptTokens,
								completionTokens,
							],
						)

				if (existing) {
					if (!existing.endpoint && entry.endpoint) {
						db.run(`UPDATE usageHistory SET endpoint = ? WHERE id = ?`, [entry.endpoint, existing.id])
					}
					return
				}
			}

			db.run(
				`INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta, requestId, latencyMs, ttftMs, cached) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					entry.timestamp,
					entry.provider || null,
					entry.model || null,
					entry.connectionId || null,
					entry.apiKey || null,
					entry.endpoint || null,
					promptTokens,
					completionTokens,
					entry.cost || 0,
					entry.status || "ok",
					stringifyJson(tokens),
					stringifyJson(entry.requestedModel ? { resolvedModel } : {}),
					entry.requestId || null,
					measuredOf(entry.latencyMs),
					measuredOf(entry.ttftMs),
					entry.cached === true ? 1 : 0,
				],
			)

			if (logOnly) {
				inserted = true
				return
			}

			const dateKey = getLocalDateKey(entry.timestamp)

			// Day rollup: append the delta next to the history insert, in the same
			// transaction. One small row, O(1) — the O(day-size) blob rewrite happens
			// in the periodic flush instead (see the coalesced writer above).
			stageDayEntry(db, dateKey, entry)

			// Atomic counter increment in same transaction
			const cur = db.get<{ value: string }>(
				`SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'`,
			)
			const next = (cur ? parseInt(cur.value, 10) : 0) + 1
			db.run(
				`INSERT INTO _meta(key, value) VALUES('totalRequestsLifetime', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
				[String(next)],
			)

			// Update API Key usedTokens and sliding window
			if (entry.apiKey) {
				const totalTokens = promptTokens + completionTokens
				if (totalTokens > 0) {
					db.run(`UPDATE apiKeys SET usedTokens = COALESCE(usedTokens, 0) + ? WHERE key = ?`, [
						totalTokens,
						entry.apiKey,
					])
				}
				// Request counter for keys limited by request count, bumped once per logged
				// usage row so the gate and this writer read the same number.
				db.run(`UPDATE apiKeys SET usedRequests = COALESCE(usedRequests, 0) + 1 WHERE key = ?`, [
					entry.apiKey,
				])
				// Daily cost counter, written in the same transaction as the usage row so the
				// two can never disagree. date('now') is UTC, the same bucket utcDayKey()
				// returns: a new day replaces the counter instead of adding to yesterday's.
				const cost = Number(entry.cost) || 0
				if (cost > 0) {
					db.run(
						`UPDATE apiKeys
                   SET costSpent = CASE WHEN costDay = date('now') THEN COALESCE(costSpent, 0) + ? ELSE ? END,
                       costDay = date('now')
                 WHERE key = ?`,
						[cost, cost, entry.apiKey],
					)
				}
				import("./apiKeysRepo.ts")
					.then(({ recordApiKeyUsageInWindow }) => {
						// The sink ignores an empty key; a request recorded without one has
						// nothing to attribute the window to.
						recordApiKeyUsageInWindow(entry.apiKey ?? "", totalTokens)
					})
					.catch(() => {})
			}

			inserted = true
		})

		// Outside the transaction: a prune is housekeeping, and doing a large DELETE
		// inside the same transaction as the insert would hold the write lock for it.
		if (!logOnly) pruneHistory(db)

		if (inserted) {
			if (!logOnly) pushToRing(entry)
			scheduleStatsEvent("update", 250)
		}
	} catch (e) {
		console.error("Failed to save usage stats:", e)
	}
}

export async function getUsageHistory(
	filter: UsageHistoryFilter = {},
): Promise<UsageHistoryRecord[]> {
	const db = await getAdapter()
	const conds: string[] = []
	const params: unknown[] = []

	if (filter.provider) {
		conds.push("provider = ?")
		params.push(filter.provider)
	}
	if (filter.model) {
		conds.push("model = ?")
		params.push(filter.model)
	}
	if (filter.startDate) {
		conds.push("timestamp >= ?")
		params.push(new Date(filter.startDate).toISOString())
	}
	if (filter.endDate) {
		conds.push("timestamp <= ?")
		params.push(new Date(filter.endDate).toISOString())
	}
	if (filter.apiKey) {
		conds.push("apiKey = ?")
		params.push(filter.apiKey)
	}

	const where = conds.length ? `WHERE ${conds.join(" AND ")}` : ""
	const rows = db.all<DbRow>(
		`SELECT timestamp, provider, model, connectionId, apiKey, endpoint, cost, status, tokens, meta FROM usageHistory ${where} ORDER BY id ASC`,
		params,
	)

	return rows.map((r) => ({
		timestamp: String(r.timestamp),
		provider: (r.provider as string | null) ?? null,
		model: (r.model as string | null) ?? null,
		connectionId: (r.connectionId as string | null) ?? null,
		apiKeyMasked: maskApiKey(r.apiKey),
		endpoint: (r.endpoint as string | null) ?? null,
		cost: Number(r.cost) || 0,
		status: (r.status as string | null) ?? null,
		tokens: parseJson<UsageTokens>(r.tokens as string | null, {}),
		resolvedModel: resolvedModelOf(r.meta),
	}))
}
