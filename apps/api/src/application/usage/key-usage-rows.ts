/** Per-key usage report: row builders. */
import {
	errorRateOf,
	KEY_REPORT_MODEL_LIMIT,
	type MergedModelRow,
	type mergeOrphanUsage,
	nextResetAt,
	percentOfCap,
	resolvedUsedTokens,
} from "../../domain/key-usage-report.ts"
import type {
	KeyAggregates,
	KeyRecord,
	KeyTotalRow,
	KeyUsageDeps,
	KeyUsageRow,
} from "./key-usage-types.ts"

const EMPTY_TOTAL: KeyTotalRow = {
	requests: 0,
	promptTokens: 0,
	completionTokens: 0,
	cost: 0,
	lastUsed: null,
}

/** One live key's row: quotas, budget, aggregates. */
export function liveRow(
	key: KeyRecord,
	allKeys: readonly KeyRecord[],
	aggregates: KeyAggregates,
	deps: KeyUsageDeps,
	now: number,
	today: string,
): KeyUsageRow {
	const totals = aggregates.totals[key.key] ?? EMPTY_TOTAL
	const promptTokens = totals.promptTokens || 0
	const completionTokens = totals.completionTokens || 0
	const status = aggregates.errorsByKey[key.key] ?? { ok: 0, errors: 0 }
	const tokenLimit = key.tokenLimit || 0

	const { used } = resolvedUsedTokens({
		columnValue: key.usedTokens,
		windowSum: aggregates.tokensInWindow[key.key] || 0,
	})
	const budget = deps.budgetOf(key, { tokenCap: tokenLimit, tokenUsed: used, today })
	const spentToday = deps.spentTodayOf(key, today)
	const dailyCostLimit = Number(key.dailyCostLimit) || 0

	return {
		id: key.id,
		name: key.name,
		createdByName: deps.creatorNameOf(key.createdBy, allKeys),
		keyMasked: deps.maskKey(key.key),
		isActive: key.isActive,
		createdAt: key.createdAt ?? null,
		expiresAt: key.expiresAt ?? null,
		expired: Boolean(key.expiresAt && new Date(key.expiresAt).getTime() < now),
		tokenLimit,
		usedTokens: used,
		usagePercent: percentOfCap(used, tokenLimit),
		resetInterval: key.resetInterval || "never",
		nextResetAt: nextResetAt(key.resetInterval, key.lastResetAt ?? null, now),
		rpmLimit: key.rpmLimit || 0,
		tpmLimit: key.tpmLimit || 0,
		requests: totals.requests || 0,
		promptTokens,
		completionTokens,
		totalTokens: promptTokens + completionTokens,
		cost: totals.cost || 0,
		// Today's spend is the cost counter regardless of which budget is selected: a token-capped
		// key still has a dollar total, and the report carries both figures.
		dailyCostLimit,
		costSpentToday: spentToday,
		costPercent: percentOfCap(spentToday, dailyCostLimit),
		limitKind: budget.kind,
		requestLimit: Number(key.requestLimit) || 0,
		usedRequests: Number(key.usedRequests) || 0,
		limitCap: budget.cap,
		limitUsed: budget.used,
		limitPercent: percentOfCap(budget.used, budget.cap),
		lastUsed: totals.lastUsed || null,
		okRequests: status.ok,
		errorRequests: status.errors,
		errorRate: errorRateOf(status.ok, status.errors),
		models: (aggregates.modelsByKey[key.key] ?? []).slice(0, KEY_REPORT_MODEL_LIMIT),
	}
}

/** The synthetic row for history whose key is no longer registered. */
export function orphanRow(orphan: ReturnType<typeof mergeOrphanUsage>): KeyUsageRow {
	return {
		id: "deleted",
		name: "Deleted keys",
		keyMasked: "",
		isActive: false,
		createdAt: null,
		expiresAt: null,
		expired: false,
		tokenLimit: 0,
		usedTokens: orphan.promptTokens + orphan.completionTokens,
		usagePercent: null,
		resetInterval: "never",
		nextResetAt: null,
		rpmLimit: 0,
		tpmLimit: 0,
		requests: orphan.requests,
		promptTokens: orphan.promptTokens,
		completionTokens: orphan.completionTokens,
		totalTokens: orphan.promptTokens + orphan.completionTokens,
		cost: orphan.cost,
		lastUsed: orphan.lastUsed,
		okRequests: orphan.ok,
		errorRequests: orphan.errors,
		errorRate: errorRateOf(orphan.ok, orphan.errors),
		models: [...orphan.models],
	}
}
