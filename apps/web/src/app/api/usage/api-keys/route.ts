import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { creatorNameFor, visibleApiKeys } from "@9router/auth/keyCreator"
import { getAdapter } from "@9router/db/driver"
import {
	compareKeyReportRows,
	errorRateOf,
	KEY_REPORT_MODEL_LIMIT,
	type MergedModelRow,
	mergeOrphanUsage,
	nextResetAt,
	percentOfCap,
	quotaWindowStart,
	resolvedUsedTokens,
	shouldReportOrphanUsage,
} from "9router-api/domain/key-usage-report"
import { NextResponse } from "next/server"
import { getApiKeys } from "@/lib/localDb"
import { budgetOf, limitKindOf, spentTodayOf, todayKey } from "@/lib/usage/keyBudget"

export const dynamic = "force-dynamic"

/** Aggregate row the GROUP BY queries below return, keyed by apiKey. */
interface KeyTotalRow {
	requests: number
	promptTokens: number
	completionTokens: number
	cost: number
	lastUsed: string | null
}

/** Per-model breakdown row, one per (apiKey, model) pair. */
interface ModelTotalRow {
	model: string
	requests: number
	tokens: number
	cost: number
	lastUsed: string | null
}

/** One row of the response: quota state plus aggregates per API key. */
interface KeyUsageRow {
	id: string
	name: string
	createdByName?: string
	keyMasked: string
	isActive: boolean
	createdAt: string | null
	expiresAt: string | null
	expired: boolean
	tokenLimit: number
	usedTokens: number
	usagePercent: number | null
	resetInterval: string
	nextResetAt: string | null
	rpmLimit: number
	tpmLimit: number
	requests: number
	promptTokens: number
	completionTokens: number
	totalTokens: number
	cost: number
	// `cost`/`requests` cap fields are per-key only: the orphan aggregate row
	// below has no key to read them from, so they stay optional and are simply
	// absent from that row's payload, exactly as before.
	dailyCostLimit?: number
	costSpentToday?: number
	costPercent?: number | null
	limitKind?: string
	requestLimit?: number
	usedRequests?: number
	limitCap?: number
	limitUsed?: number
	limitPercent?: number | null
	lastUsed: string | null
	okRequests: number
	errorRequests: number
	errorRate: number
	// A live key's rows arrive straight from SQL; the merged "Deleted keys" row is
	// summed in the domain and is fully typed. Both render in the same panel.
	models: (ModelTotalRow | MergedModelRow)[]
}

function maskKey(key) {
	if (!key || typeof key !== "string") return ""
	return key.length <= 10 ? key.slice(0, 4) + "***" : key.slice(0, 10) + "***"
}

// GET /api/usage/api-keys - one row per generated API key: quota state plus
// request/token/cost aggregates and per-model breakdown from usageHistory.
export async function GET() {
	try {
		const ctx = await getSessionContext()
		const ownKey = ctx.apiKeyFilter
		const allKeys = await getApiKeys()
		// Same visibility rule as the endpoint list: an API key session sees its own
		// key plus the keys it created, and never another branch's names, quotas or
		// model scopes. Keeping this per-page was the bug - a key that created a key
		// saw the child on the endpoint page and not here.
		const keys = visibleApiKeys(allKeys, ctx.session)
		const [db] = await Promise.all([getAdapter()])
		const now = Date.now()

		const keyCond = ownKey ? "WHERE apiKey = ?" : ""
		const keyParams = ownKey ? [ownKey] : []

		const totalsByRaw = db.all<KeyTotalRow & { apiKey: string | null }>(
			`SELECT apiKey, COUNT(*) AS requests,
              COALESCE(SUM(promptTokens), 0) AS promptTokens,
              COALESCE(SUM(completionTokens), 0) AS completionTokens,
              COALESCE(SUM(cost), 0) AS cost,
              MAX(timestamp) AS lastUsed
         FROM usageHistory ${keyCond} GROUP BY apiKey`,
			keyParams,
		)
		const totals: Record<string, KeyTotalRow> = {}
		for (const r of totalsByRaw) totals[r.apiKey || ""] = r

		const modelsByRaw = db.all<ModelTotalRow & { apiKey: string | null }>(
			`SELECT apiKey, model, COUNT(*) AS requests,
              COALESCE(SUM(promptTokens + completionTokens), 0) AS tokens,
              COALESCE(SUM(cost), 0) AS cost,
              MAX(timestamp) AS lastUsed
         FROM usageHistory ${keyCond} GROUP BY apiKey, model
        ORDER BY requests DESC`,
			keyParams,
		)
		const modelsByKey: Record<string, ModelTotalRow[]> = {}
		for (const r of modelsByRaw) {
			const k = r.apiKey || ""
			;(modelsByKey[k] ??= []).push({
				model: r.model || "unknown",
				requests: r.requests,
				tokens: r.tokens,
				cost: r.cost,
				lastUsed: r.lastUsed,
			})
		}

		const tokensInWindowMap: Record<string, number> = {}
		for (const k of keys) {
			const sinceTs = quotaWindowStart(k.resetInterval, now)
			const row = db.get<{ usedTokensInWindow: number }>(
				`SELECT COALESCE(SUM(promptTokens + completionTokens), 0) AS usedTokensInWindow
           FROM usageHistory
          WHERE apiKey = ? AND timestamp >= ?`,
				[k.key, sinceTs],
			)
			tokensInWindowMap[k.key] = row?.usedTokensInWindow || 0
		}

		const statusByRaw = db.all<{ apiKey: string | null; status: string | null; count: number }>(
			`SELECT apiKey, status, COUNT(*) AS count FROM usageHistory ${keyCond} GROUP BY apiKey, status`,
			keyParams,
		)
		const errorsByKey: Record<string, { errors: number; ok: number }> = {}
		for (const r of statusByRaw) {
			const k = r.apiKey || ""
			const row = (errorsByKey[k] ??= { errors: 0, ok: 0 })
			const s = String(r.status || "ok").toLowerCase()
			if (s === "ok" || s === "success") row.ok += r.count
			else row.errors += r.count
		}

		const today = todayKey()
		// Annotated so both row kinds share one shape: the per-key rows carry
		// createdByName and the quota cap fields, the orphan aggregate does not.
		const result: KeyUsageRow[] = keys.map((k) => {
			const t: KeyTotalRow = totals[k.key] || {
				requests: 0,
				promptTokens: 0,
				completionTokens: 0,
				cost: 0,
				lastUsed: null,
			}
			const promptTokens = t.promptTokens || 0
			const completionTokens = t.completionTokens || 0
			const st = errorsByKey[k.key] || { ok: 0, errors: 0 }
			const limit = k.tokenLimit || 0
			// The column is the quota authority but the log can be ahead of it; see
			// `resolvedUsedTokens` for why the larger of the two is the honest number.
			const { used } = resolvedUsedTokens({
				columnValue: k.usedTokens,
				windowSum: tokensInWindowMap[k.key] || 0,
			})
			// One unified budget per key: the page shows the kind the owner selected rather
			// than three numbers, and the percentage is measured against that same cap.
			const kind = limitKindOf(k)
			const budget = budgetOf(k, { tokenCap: limit, tokenUsed: used, today })
			const cap = budget.cap
			const usedForCap = budget.used
			// Spend today is the cost counter regardless of which budget is selected: the
			// report carries both figures, and a token-capped key still has a dollar total.
			const spentToday = spentTodayOf(k, today)
			return {
				id: k.id,
				name: k.name,
				createdByName: creatorNameFor({ createdBy: k.createdBy, keys: allKeys }),
				keyMasked: maskKey(k.key),
				isActive: k.isActive,
				createdAt: k.createdAt,
				expiresAt: k.expiresAt,
				expired: Boolean(k.expiresAt && new Date(k.expiresAt).getTime() < now),
				tokenLimit: limit,
				usedTokens: used,
				usagePercent: percentOfCap(used, limit),
				resetInterval: k.resetInterval || "never",
				nextResetAt: nextResetAt(k.resetInterval, k.lastResetAt, now),
				rpmLimit: k.rpmLimit || 0,
				tpmLimit: k.tpmLimit || 0,
				requests: t.requests || 0,
				promptTokens,
				completionTokens,
				totalTokens: promptTokens + completionTokens,
				cost: t.cost || 0,
				// Today's spend comes from the same counter validateApiKey enforces, not from
				// the pruned usage log, so the page and the 429 can never disagree.
				dailyCostLimit: Number(k.dailyCostLimit) || 0,
				costSpentToday: spentToday,
				costPercent: percentOfCap(spentToday, Number(k.dailyCostLimit) || 0),
				limitKind: kind,
				requestLimit: Number(k.requestLimit) || 0,
				usedRequests: Number(k.usedRequests) || 0,
				limitCap: cap,
				limitUsed: usedForCap,
				limitPercent: percentOfCap(usedForCap, cap),
				lastUsed: t.lastUsed || null,
				okRequests: st.ok,
				errorRequests: st.errors,
				errorRate: errorRateOf(st.ok, st.errors),
				models: (modelsByKey[k.key] || []).slice(0, KEY_REPORT_MODEL_LIMIT),
			}
		})

		// Orphan usage (history for keys no longer registered) is only meaningful when
		// listing every key; an API-key session sees one row, and its unseen keys are
		// not "deleted". `shouldReportOrphanUsage` states that.
		if (shouldReportOrphanUsage(ownKey)) {
			const known = new Set(keys.map((k) => k.key))
			const orphan = Object.keys(totals).filter((raw) => raw && !known.has(raw))
			if (orphan.length > 0) {
				const merged = mergeOrphanUsage(orphan, totals, errorsByKey, modelsByKey)
				result.push({
					id: "deleted",
					name: "Deleted keys",
					keyMasked: "",
					isActive: false,
					createdAt: null,
					expiresAt: null,
					expired: false,
					tokenLimit: 0,
					usedTokens: merged.promptTokens + merged.completionTokens,
					usagePercent: null,
					resetInterval: "never",
					nextResetAt: null,
					rpmLimit: 0,
					tpmLimit: 0,
					requests: merged.requests,
					promptTokens: merged.promptTokens,
					completionTokens: merged.completionTokens,
					totalTokens: merged.promptTokens + merged.completionTokens,
					cost: merged.cost,
					lastUsed: merged.lastUsed,
					okRequests: merged.ok,
					errorRequests: merged.errors,
					errorRate: errorRateOf(merged.ok, merged.errors),
					models: [...merged.models],
				})
			}
		}

		result.sort(compareKeyReportRows)

		return NextResponse.json(
			{
				keys: result,
				generatedAt: new Date().toISOString(),
				permissions: ctx.permissions,
			},
			{ headers: { "Cache-Control": "no-store" } },
		)
	} catch (error) {
		console.log("Error aggregating per-key usage:", error)
		return NextResponse.json(
			{ error: error?.message || "Failed to load per-key usage" },
			{ status: 500 },
		)
	}
}
