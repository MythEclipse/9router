/**
 * Latency and hourly-spend readers.
 *
 * Extracted verbatim from usageRepo.ts.
 */

import { getAdapter } from "../driver.ts"
import { parseJson } from "../helpers/jsonCol.ts"
import type { DbRow } from "../types.ts"

import { matchesAllowedModels as matchesModelPatterns, parseAllowedModels } from "./apiKeysRepo.ts"

export interface LatencySample {
	readonly timestamp: string
	readonly provider: string | null
	readonly model: string | null
	readonly connectionId: string | null
	readonly apiKey: string | null
	readonly latencyMs: number
	/** `null` for a non-streamed answer, which has no first token to time. */
	readonly ttftMs: number | null
	readonly cached: boolean
}

export interface LatencySampleQuery {
	/** ISO timestamp; rows older than this are not read. */
	readonly since: string
	/** Restrict to one key, as an API-key session must. */
	readonly apiKey?: string | null
	/** The key's model patterns; `"*"` means all. */
	readonly allowedModels?: string
	/** Safety valve for an install with a very busy window. */
	readonly limit?: number
}

/**
 * Timed requests in the window, oldest first.
 *
 * Rows without `latencyMs` are excluded in SQL rather than in the caller: they are the
 * majority on an install that predates the column, and shipping them out to be filtered
 * would move megabytes to answer a question about a percentile.
 *
 * The model filter is applied in JS because the patterns live in `apiKeysRepo` and are not
 * expressible in SQL without re-implementing the matcher — which is exactly the duplication
 * that makes an API-key session see another key's traffic.
 */
export async function getLatencySamples(query: LatencySampleQuery): Promise<LatencySample[]> {
	try {
		const db = await getAdapter()
		const patterns = parseAllowedModels(query.allowedModels)
		const where = ["timestamp >= ?", "latencyMs IS NOT NULL"]
		const params: unknown[] = [query.since]
		if (query.apiKey) {
			where.push("apiKey = ?")
			params.push(query.apiKey)
		}
		const limit = Math.max(1, Math.min(Math.trunc(query.limit ?? 50_000), 200_000))
		const rows = db.all<DbRow>(
			`SELECT timestamp, provider, model, connectionId, apiKey, latencyMs, ttftMs, cached
			 FROM usageHistory
			 WHERE ${where.join(" AND ")}
			 ORDER BY id DESC
			 LIMIT ?`,
			[...params, limit],
		)
		return rows
			.map((row) => sampleOfRow(row))
			.filter((sample): sample is LatencySample => sample !== null)
			.filter((sample) => matchesModelPatterns(patterns, sample.model ?? ""))
			.reverse()
	} catch (e) {
		// An unreadable table answers "no measurements", which the report already renders as
		// "not enough data". Failing the whole page for a panel would hide the rest of it.
		console.error("[usageRepo] getLatencySamples failed:", e instanceof Error ? e.message : e)
		return []
	}
}

/** A stored row as a sample, or `null` when the timing is unusable. */
function sampleOfRow(row: DbRow): LatencySample | null {
	const latencyMs = Number(row.latencyMs)
	if (!Number.isFinite(latencyMs) || latencyMs < 0) return null
	const ttft = row.ttftMs === null || row.ttftMs === undefined ? null : Number(row.ttftMs)
	return {
		timestamp: String(row.timestamp ?? ""),
		provider: row.provider ? String(row.provider) : null,
		model: row.model ? String(row.model) : null,
		connectionId: row.connectionId ? String(row.connectionId) : null,
		apiKey: row.apiKey ? String(row.apiKey) : null,
		latencyMs,
		ttftMs: ttft !== null && Number.isFinite(ttft) && ttft >= 0 ? ttft : null,
		cached: Number(row.cached ?? 0) === 1,
	}
}

/** One hour of spend for one key (or for the whole install when `key` is `"*"`). */
export interface HourlySpendRow {
	readonly key: string
	/** Local-time hour bucket, `YYYY-MM-DDTHH`. */
	readonly hour: string
	readonly cost: number
}

export interface HourlySpendQuery {
	readonly since: string
	/** Restrict to one key, as an API-key session must. */
	readonly apiKey?: string | null
	/** The key's model patterns; `"*"` means all. */
	readonly allowedModels?: string
}

/**
 * Spend per key per local hour, oldest first.
 *
 * Grouped in SQL because the alternative — one row per request over a month of traffic — is
 * the whole table. `localtime` is deliberate: an "hour" in this report means the clock on the
 * wall beside the operator, matching the day buckets `usageDaily` already uses. Grouping in
 * UTC would put a 02:00 spike (local) in the previous day's last hour, which is precisely the
 * hour an operator is not watching.
 *
 * The model scope is applied in JS for the same reason `getLatencySamples` does it: the
 * pattern language lives in one place and is not re-implemented in SQL.
 */
export async function getHourlySpend(query: HourlySpendQuery): Promise<HourlySpendRow[]> {
	try {
		const db = await getAdapter()
		const patterns = parseAllowedModels(query.allowedModels)
		const where = ["timestamp >= ?", "status = 'ok'"]
		const params: unknown[] = [query.since]
		if (query.apiKey) {
			where.push("apiKey = ?")
			params.push(query.apiKey)
		}
		const rows = db.all<DbRow>(
			`SELECT COALESCE(apiKey, '') AS bucketKey,
			        strftime('%Y-%m-%dT%H', timestamp, 'localtime') AS hour,
			        model AS model,
			        COALESCE(cost, 0) AS cost
			 FROM usageHistory
			 WHERE ${where.join(" AND ")}
			 ORDER BY id ASC`,
			params,
		)
		const merged = new Map<string, HourlySpendRow>()
		for (const row of rows) {
			const model = row.model ? String(row.model) : ""
			if (!matchesModelPatterns(patterns, model)) continue
			const key = row.bucketKey ? String(row.bucketKey) : "*"
			const hour = String(row.hour ?? "")
			if (!hour) continue
			const cost = Number(row.cost)
			if (!Number.isFinite(cost) || cost <= 0) continue
			const id = `${key}|${hour}`
			const existing = merged.get(id)
			if (existing) merged.set(id, { ...existing, cost: existing.cost + cost })
			else merged.set(id, { key, hour, cost })
		}
		return [...merged.values()].sort((a, b) => a.hour.localeCompare(b.hour))
	} catch (e) {
		console.error("[usageRepo] getHourlySpend failed:", e instanceof Error ? e.message : e)
		return []
	}
}
