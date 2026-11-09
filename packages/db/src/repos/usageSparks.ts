/**
 * Sparkline readers.
 *
 * Extracted verbatim from usageRepo.ts.
 */

import { getAdapter } from "../driver.ts"
import { parseJson } from "../helpers/jsonCol.ts"
import type { DbRow } from "../types.ts"

import { matchesAllowedModels as matchesModelPatterns, parseAllowedModels } from "./apiKeysRepo.ts"
import { emptyDay } from "./usageDayRollup.ts"
import type { ModelUsageCounter, UsageDay } from "./usageTypes.ts"

export async function getSparks(
	period = "30d",
	filterApiKey: string | null = null,
	allowedModels = "*",
) {
	const db = await getAdapter()

	const patterns = parseAllowedModels(allowedModels)
	const modelAllowed = (model: string) => matchesModelPatterns(patterns, model)

	const DAYS = { today: 1, "24h": 1, "7d": 7, "30d": 30, "60d": 60, all: 60 }[period] || 30

	const totals: Record<"requests" | "input" | "output" | "cost" | "cached", number[]> = {
		requests: [],
		input: [],
		output: [],
		cost: [],
		cached: [],
	}
	const rows = db.all<{ dateKey: string; data: string }>(
		`SELECT dateKey, data FROM usageDaily WHERE dateKey >= ? ORDER BY dateKey ASC`,
		[localCutoffKey(DAYS)],
	)
	const byKey: Record<string, UsageDay> = {}
	for (const r of rows) byKey[r.dateKey] = parseJson<UsageDay>(r.data, emptyDay())

	for (let i = DAYS - 1; i >= 0; i -= 1) {
		const key = offsetKey(i)
		const day = byKey[key]
		if (!day) {
			totals.requests.push(0)
			totals.input.push(0)
			totals.output.push(0)
			totals.cost.push(0)
			totals.cached.push(0)
			continue
		}
		// usageDaily has no top-level cachedTokens - it lives per model bucket.
		const dayCached = (Object.values(day.byModel || {}) as ModelUsageCounter[]).reduce(
			(sum, m) => sum + (Number(m.cachedTokens) || 0),
			0,
		)
		if (patterns === null && !filterApiKey) {
			totals.requests.push(Number(day.requests) || 0)
			totals.input.push(Number(day.promptTokens) || 0)
			totals.output.push(Number(day.completionTokens) || 0)
			totals.cost.push(Number(day.cost) || 0)
			totals.cached.push(dayCached)
			continue
		}
		// Session-scoped: sum only the allowed models from the per-model buckets.
		let req = 0,
			pin = 0,
			pout = 0,
			cost = 0,
			cached = 0
		for (const [mk, m] of Object.entries(day.byModel || {}) as Array<[string, ModelUsageCounter]>) {
			const rawModel = m.rawModel || String(mk).split("|")[0]
			if (!modelAllowed(rawModel)) continue
			req += Number(m.requests) || 0
			pin += Number(m.promptTokens) || 0
			pout += Number(m.completionTokens) || 0
			cost += Number(m.cost) || 0
			cached += Number(m.cachedTokens) || 0
		}
		totals.requests.push(req)
		totals.input.push(pin)
		totals.output.push(pout)
		totals.cost.push(cost)
		totals.cached.push(cached)
	}

	// Heatmap source: the most recent rows the session may see. Capped - a
	// heat cell is a traffic pattern, not an audit trail.
	const keyRows = filterApiKey
		? db.all(`SELECT timestamp FROM usageHistory WHERE apiKey = ? ORDER BY id DESC LIMIT 500`, [
				filterApiKey,
			])
		: db.all(`SELECT timestamp FROM usageHistory ORDER BY id DESC LIMIT 500`)
	const heatTimestamps = keyRows.map((r) => r.timestamp)

	return { days: DAYS, totals, heatTimestamps }
}

function toLocalKey(d: Date): string {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

function offsetKey(daysAgo: number): string {
	const d = new Date()
	d.setDate(d.getDate() - daysAgo)
	return toLocalKey(d)
}

function localCutoffKey(n: number): string {
	return offsetKey(n - 1)
}
