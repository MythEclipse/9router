/**
 * Chart reader.
 *
 * Extracted verbatim from usageRepo.ts.
 */

import { getAdapter } from "../driver.ts"
import { parseJson } from "../helpers/jsonCol.ts"
import type { DbRow } from "../types.ts"

import { matchesAllowedModels as matchesModelPatterns, parseAllowedModels } from "./apiKeysRepo.ts"
import { emptyDay, flushDayRollupQuietly } from "./usageDayRollup.ts"
import { loadDaysInRange } from "./usageRecent.ts"
import type { ChartBucket, ModelUsageCounter, UsageDay } from "./usageTypes.ts"

export async function getChartData(
	period = "7d",
	filterApiKey: string | null = null,
	allowedModels = "*",
) {
	const db = await getAdapter()
	// Same rule as getUsageStats: fold staged rollup deltas in before reading.
	// ("24h"/"today" read usageHistory, where the row is already written; the
	// flush is a no-op for them and costs one map-size check otherwise.)
	await flushDayRollupQuietly()
	// Same rule as getUsageStats: pending/error rows are log entries, not usage.
	const _USAGE_ONLY = `COALESCE(status, 'ok') NOT IN ('pending', 'error')`
	const now = Date.now()

	const patterns = parseAllowedModels(allowedModels)
	const modelAllowed = (model: string) => matchesModelPatterns(patterns, model)

	// For "today" and "24h", use hourly buckets from usageHistory (already has filterApiKey support)
	if (period === "today") {
		const bucketCount = 24
		const bucketMs = 3600000
		const startOfDay = new Date()
		startOfDay.setHours(0, 0, 0, 0)
		const startTime = startOfDay.getTime()
		const endTime = startTime + bucketCount * bucketMs
		const labelFn = (ts: number) =>
			new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })
		const buckets = Array.from({ length: bucketCount }, (_, i) => ({
			label: labelFn(startTime + i * bucketMs),
			tokens: 0,
			cost: 0,
			requests: 0,
		}))

		const sql = filterApiKey
			? `SELECT timestamp, model, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ? AND apiKey = ? AND status = 'ok'`
			: `SELECT timestamp, model, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ? AND status = 'ok'`
		const params = filterApiKey
			? [new Date(startTime).toISOString(), filterApiKey]
			: [new Date(startTime).toISOString()]
		const rows = db.all<DbRow>(sql, params)
		for (const r of rows) {
			if (!modelAllowed(String(r.model ?? ""))) continue
			const t = new Date(String(r.timestamp)).getTime()
			if (t < startTime || t >= endTime) continue
			const idx = Math.floor((t - startTime) / bucketMs)
			if (idx >= 0 && idx < bucketCount) {
				buckets[idx].tokens += (Number(r.promptTokens) || 0) + (Number(r.completionTokens) || 0)
				buckets[idx].cost += Number(r.cost) || 0
				buckets[idx].requests += 1
			}
		}
		return buckets
	}

	if (period === "24h") {
		const bucketCount = 24
		const bucketMs = 3600000
		const labelFn = (ts: number) =>
			new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })
		const startTime = now - bucketCount * bucketMs
		const buckets = Array.from({ length: bucketCount }, (_, i) => ({
			label: labelFn(startTime + i * bucketMs),
			tokens: 0,
			cost: 0,
			requests: 0,
		}))

		const sql = filterApiKey
			? `SELECT timestamp, model, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ? AND apiKey = ? AND status = 'ok'`
			: `SELECT timestamp, model, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ? AND status = 'ok'`
		const params = filterApiKey
			? [new Date(startTime).toISOString(), filterApiKey]
			: [new Date(startTime).toISOString()]
		const rows = db.all<DbRow>(sql, params)
		for (const r of rows) {
			if (!modelAllowed(String(r.model ?? ""))) continue
			const t = new Date(String(r.timestamp)).getTime()
			if (t < startTime || t > now) continue
			const idx = Math.min(Math.floor((t - startTime) / bucketMs), bucketCount - 1)
			buckets[idx].tokens += (Number(r.promptTokens) || 0) + (Number(r.completionTokens) || 0)
			buckets[idx].cost += Number(r.cost) || 0
			buckets[idx].requests += 1
		}
		return buckets
	}

	// For "all", "7d", "30d", "60d" - use daily buckets
	// If filterApiKey is provided, query usageHistory directly to avoid leaking data from other API keys
	// usageDaily contains aggregated data for ALL API keys in its byApiKey field
	const labelFn = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" })

	let startTime: number
	let bucketCount: number
	if (period === "all") {
		// For "all", find earliest date from usageHistory
		const earliestRow = db.get<{ minTs: string | null }>(
			`SELECT MIN(timestamp) as minTs FROM usageHistory${filterApiKey ? " WHERE apiKey = ?" : ""}`,
			filterApiKey ? [filterApiKey] : [],
		)
		if (!earliestRow?.minTs) return []
		const earliest = new Date(earliestRow.minTs)
		earliest.setHours(0, 0, 0, 0)
		const today = new Date()
		today.setHours(0, 0, 0, 0)
		bucketCount = Math.max(1, Math.round((today.getTime() - earliest.getTime()) / 86400000) + 1)
		startTime = earliest.getTime()
	} else {
		bucketCount = period === "7d" ? 7 : period === "30d" ? 30 : 60
		const today = new Date()
		today.setHours(0, 0, 0, 0)
		startTime = today.getTime() - (bucketCount - 1) * 86400000
	}

	// Query usageHistory directly when filterApiKey is provided, otherwise use usageDaily for performance
	if (filterApiKey) {
		const sql = `SELECT timestamp, model, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ? AND apiKey = ?`
		const params = [new Date(startTime).toISOString(), filterApiKey]
		const rows = db.all<DbRow>(sql, params)

		const dayMap: Record<string, ChartBucket> = {}
		for (const r of rows) {
			if (!modelAllowed(String(r.model ?? ""))) continue
			const d = new Date(String(r.timestamp))
			d.setHours(0, 0, 0, 0)
			const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
			dayMap[dateKey] ||= { tokens: 0, cost: 0, requests: 0 }
			dayMap[dateKey].tokens += (Number(r.promptTokens) || 0) + (Number(r.completionTokens) || 0)
			dayMap[dateKey].cost += Number(r.cost) || 0
			dayMap[dateKey].requests += 1
		}

		return Array.from({ length: bucketCount }, (_, i) => {
			const d = new Date(startTime + i * 86400000)
			const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
			const dayData = dayMap[dateKey]
			return {
				label: labelFn(d),
				tokens: dayData ? dayData.tokens : 0,
				cost: dayData ? dayData.cost : 0,
				requests: dayData ? dayData.requests : 0,
			}
		})
	}

	// No filterApiKey - use usageDaily for better performance (admin/global view)
	const dayRows = loadDaysInRange(db, period === "all" ? null : bucketCount)
	const dayMap: Record<string, UsageDay> = {}
	for (const r of dayRows) {
		const dayData = parseJson<UsageDay>(r.data, emptyDay())
		if (patterns === null) {
			// No model restriction - use day totals directly
			dayMap[r.dateKey] = dayData
		} else {
			// Model restricted - sum only matching models from byModel
			let totalRequests = 0
			let totalPromptTokens = 0
			let totalCompletionTokens = 0
			let totalCachedTokens = 0
			let totalCost = 0
			for (const [mk, m] of Object.entries(dayData.byModel || {}) as Array<
				[string, ModelUsageCounter]
			>) {
				const rawModel = m.rawModel || mk.split("|")[0]
				if (!modelAllowed(rawModel)) continue
				totalRequests += m.requests || 0
				totalPromptTokens += m.promptTokens || 0
				totalCompletionTokens += m.completionTokens || 0
				totalCachedTokens += m.cachedTokens || 0
				totalCost += m.cost || 0
			}
			if (totalRequests > 0) {
				dayMap[r.dateKey] = {
					requests: totalRequests,
					promptTokens: totalPromptTokens,
					completionTokens: totalCompletionTokens,
					cachedTokens: totalCachedTokens,
					cost: totalCost,
				}
			}
		}
	}

	return Array.from({ length: bucketCount }, (_, i) => {
		const d = new Date(startTime + i * 86400000)
		const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
		const dayData = dayMap[dateKey]
		return {
			label: labelFn(d),
			tokens: dayData ? (dayData.promptTokens || 0) + (dayData.completionTokens || 0) : 0,
			cost: dayData ? dayData.cost || 0 : 0,
			requests: dayData ? dayData.requests || 0 : 0,
		}
	})
}

/**
 * Compact per-day totals for the Overview sparklines (#16) plus a session-
 * scoped activity pulse for the heatmap (#15).
 *
 * The sparklines read `usageDaily`, so an idle day is a real zero - distinct
 * from the chart API, which merges today's live rows. The heatmap buckets the
 * 60 most recent session-scoped requests by local weekday × hour; session
 * scoping matches the rest of the Overview, so a key user sees their own
 * pattern and not the whole server's.
 */
