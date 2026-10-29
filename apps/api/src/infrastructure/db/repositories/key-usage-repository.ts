/**
 * The per-key usage aggregates, as SQL.
 *
 * Split from the use-case on the rule that a query is infrastructure and a fold is a rule. The
 * queries here used to live inside the route, interleaved with the row assembly, so the scope
 * condition (`WHERE apiKey = ?`) was written four times and could drift between them — a panel
 * that narrows in three queries and not the fourth shows another branch's tokens.
 *
 * `scopeClause` names the condition once and every query takes it.
 */

import { getAdapter } from "@9router/db/driver"
import type {
	KeyAggregates,
	KeyRecord,
	KeyTotalRow,
	ModelTotalRow,
} from "../../../application/usage/key-usage-report.ts"

interface KeyTotalRowWithKey extends KeyTotalRow {
	apiKey: string | null
}

interface ModelTotalRowWithKey extends ModelTotalRow {
	apiKey: string | null
}

interface StatusCountRow {
	apiKey: string | null
	status: string | null
	count: number
}

/** The one condition every aggregate shares: a key session sees only its own key's rows. */
function scopeClause(ownKey: string | null): { sql: string; params: unknown[] } {
	if (!ownKey) return { sql: "", params: [] }
	return { sql: "WHERE apiKey = ?", params: [ownKey] }
}

/**
 * Tokens per key inside its own quota window.
 *
 * One query per key, because the window start depends on that key's reset interval. A key with
 * `never` has a window starting at the epoch, so its whole history counts — which is what the
 * page has always shown, and is not the same as "no usage".
 */
async function tokensInWindows(
	keys: readonly KeyRecord[],
	now: number,
): Promise<Record<string, number>> {
	const { quotaWindowStart } = await import("../../../domain/key-usage-report.ts")
	const db = await getAdapter()
	const out: Record<string, number> = {}
	for (const key of keys) {
		const since = quotaWindowStart(key.resetInterval, now)
		const row = db.get<{ usedTokensInWindow: number }>(
			`SELECT COALESCE(SUM(promptTokens + completionTokens), 0) AS usedTokensInWindow
			   FROM usageHistory
			  WHERE apiKey = ? AND timestamp >= ?`,
			[key.key, since],
		)
		out[key.key] = row?.usedTokensInWindow || 0
	}
	return out
}

export async function aggregatesOf(input: {
	readonly ownKey: string | null
	readonly keys: readonly KeyRecord[]
	readonly now: number
}): Promise<KeyAggregates> {
	const db = await getAdapter()
	const scope = scopeClause(input.ownKey)

	const totalsByRaw = db.all<KeyTotalRowWithKey>(
		`SELECT apiKey, COUNT(*) AS requests,
		        COALESCE(SUM(promptTokens), 0) AS promptTokens,
		        COALESCE(SUM(completionTokens), 0) AS completionTokens,
		        COALESCE(SUM(cost), 0) AS cost,
		        MAX(timestamp) AS lastUsed
		   FROM usageHistory ${scope.sql} GROUP BY apiKey`,
		scope.params,
	)
	const totals: Record<string, KeyTotalRow> = {}
	for (const row of totalsByRaw) totals[row.apiKey || ""] = row

	const modelsByRaw = db.all<ModelTotalRowWithKey>(
		`SELECT apiKey, model, COUNT(*) AS requests,
		        COALESCE(SUM(promptTokens + completionTokens), 0) AS tokens,
		        COALESCE(SUM(cost), 0) AS cost,
		        MAX(timestamp) AS lastUsed
		   FROM usageHistory ${scope.sql} GROUP BY apiKey, model
		  ORDER BY requests DESC`,
		scope.params,
	)
	const modelsByKey: Record<string, ModelTotalRow[]> = {}
	for (const row of modelsByRaw) {
		const bucket = (modelsByKey[row.apiKey || ""] ??= [])
		bucket.push({
			model: row.model || "unknown",
			requests: row.requests,
			tokens: row.tokens,
			cost: row.cost,
			lastUsed: row.lastUsed,
		})
	}

	const statusByRaw = db.all<StatusCountRow>(
		`SELECT apiKey, status, COUNT(*) AS count FROM usageHistory ${scope.sql}
		  GROUP BY apiKey, status`,
		scope.params,
	)
	const errorsByKey: Record<string, { ok: number; errors: number }> = {}
	for (const row of statusByRaw) {
		const bucket = (errorsByKey[row.apiKey || ""] ??= { ok: 0, errors: 0 })
		// The column is written as `OK` by some paths, `200` by others, and left absent by paths
		// that record only failures — so success is recognised by name, and absence reads as ok.
		const status = String(row.status || "ok").toLowerCase()
		if (status === "ok" || status === "success" || status === "200") bucket.ok += row.count
		else bucket.errors += row.count
	}

	return {
		totals,
		modelsByKey,
		errorsByKey,
		tokensInWindow: await tokensInWindows(input.keys, input.now),
	}
}
