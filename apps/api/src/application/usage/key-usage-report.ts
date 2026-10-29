/**
 * Per-key usage report: one row per generated API key.
 *
 * The route grew to 288 lines because it did four things in one function — read the key list,
 * run five aggregate queries, fold them into rows, then append a synthetic "Deleted keys" row.
 * Only the fold is a rule; the queries are a port. This file keeps the fold and names what the
 * old shape hid:
 *
 * - **The orphan row is only meaningful when every key is visible.** An API-key session sees one
 *   row and its unseen keys are not "deleted" — reporting them would show that session a total
 *   including keys it may not know about. `shouldReportOrphanUsage` states that.
 * - **Quota used is the larger of two numbers, not the column.** The stored counter is the
 *   authority but the usage log can be ahead of it (a crash between the two writes), so
 *   `resolvedUsedTokens` takes the max. Reading the column alone reports a key as fresh while
 *   the log says it is spent.
 * - **Spend-today comes from the enforcement counter, not the pruned log.** The page and the
 *   429 must never disagree, so `spentTodayOf` reads the same figure `validateApiKey` does.
 *
 * The row has two kinds: a live key with every cap field, and the synthetic orphan aggregate
 * which has no key to read caps from. That is why those fields are optional here rather than
 * invented as zeros — absent means "this row has no cap", not "the cap is zero".
 */
import { AppError } from "../../domain/errors.ts"
import {
	compareKeyReportRows,
	errorRateOf,
	KEY_REPORT_MODEL_LIMIT,
	type MergedModelRow,
	mergeOrphanUsage,
	nextResetAt,
	percentOfCap,
	resolvedUsedTokens,
	shouldReportOrphanUsage,
} from "../../domain/key-usage-report.ts"

/** The subset of a stored key the report reads; the host's record carries more. */
export interface KeyRecord {
	readonly id: string
	readonly name: string
	readonly key: string
	readonly createdBy?: unknown
	readonly isActive: boolean
	readonly createdAt?: string | null
	readonly expiresAt?: string | null
	readonly tokenLimit?: number
	readonly usedTokens?: number
	readonly resetInterval?: string | null
	readonly lastResetAt?: number | null
	readonly rpmLimit?: number
	readonly tpmLimit?: number
	readonly dailyCostLimit?: number | string | null
	readonly requestLimit?: number | string | null
	readonly usedRequests?: number | string | null
}

export interface KeyTotalRow {
	readonly requests: number
	readonly promptTokens: number
	readonly completionTokens: number
	readonly cost: number
	readonly lastUsed: string | null
}

export interface ModelTotalRow {
	readonly model: string
	readonly requests: number
	readonly tokens: number
	readonly cost: number
	readonly lastUsed: string | null
}

/** The aggregates for every key, as the port returns them. */
export interface KeyAggregates {
	readonly totals: Readonly<Record<string, KeyTotalRow>>
	readonly modelsByKey: Readonly<Record<string, readonly ModelTotalRow[]>>
	readonly errorsByKey: Readonly<Record<string, { readonly ok: number; readonly errors: number }>>
	/** Tokens per raw key inside its own quota window. */
	readonly tokensInWindow: Readonly<Record<string, number>>
}

export interface KeyUsageDeps {
	/** Every stored key, unfiltered: the visibility rule needs the whole list. */
	readonly listKeys: () => Promise<readonly KeyRecord[]>
	/** Narrows the list to what this session may see. */
	readonly visibleKeys: (keys: readonly KeyRecord[], session: unknown) => readonly KeyRecord[]
	/** Who created a key, resolved from the same full list. */
	readonly creatorNameOf: (createdBy: unknown, keys: readonly KeyRecord[]) => string | undefined
	/**
	 * The aggregate queries. Supplied by the infrastructure factory, not the host: they read the
	 * shared database, which the host does not own. Optional here so the host's object states
	 * only what the host knows; the factory fills the rest.
	 */
	readonly aggregatesOf?: (input: {
		readonly ownKey: string | null
		readonly keys: readonly KeyRecord[]
		readonly now: number
	}) => Promise<KeyAggregates>
	/** The budget kind and cap a key enforces, and how much of it is spent. */
	readonly budgetOf: (
		key: KeyRecord,
		context: { readonly tokenCap: number; readonly tokenUsed: number; readonly today: string },
	) => { readonly kind: string; readonly cap: number; readonly used: number }
	readonly spentTodayOf: (key: KeyRecord, today: string) => number
	readonly todayKey: () => string
	/** Masks a raw key for display. */
	readonly maskKey: (key: string) => string
	readonly now: () => number
}

/** One row of the report: quota state plus aggregates. */
export interface KeyUsageRow {
	readonly id: string
	readonly name: string
	readonly createdByName?: string
	readonly keyMasked: string
	readonly isActive: boolean
	readonly createdAt: string | null
	readonly expiresAt: string | null
	readonly expired: boolean
	readonly tokenLimit: number
	readonly usedTokens: number
	readonly usagePercent: number | null
	readonly resetInterval: string
	readonly nextResetAt: string | null
	readonly rpmLimit: number
	readonly tpmLimit: number
	readonly requests: number
	readonly promptTokens: number
	readonly completionTokens: number
	readonly totalTokens: number
	readonly cost: number
	readonly dailyCostLimit?: number
	readonly costSpentToday?: number
	readonly costPercent?: number | null
	readonly limitKind?: string
	readonly requestLimit?: number
	readonly usedRequests?: number
	readonly limitCap?: number
	readonly limitUsed?: number
	readonly limitPercent?: number | null
	readonly lastUsed: string | null
	readonly okRequests: number
	readonly errorRequests: number
	readonly errorRate: number
	readonly models: readonly (ModelTotalRow | MergedModelRow)[]
}

export interface KeyUsageReport {
	readonly keys: readonly KeyUsageRow[]
	readonly generatedAt: string
}

const EMPTY_TOTAL: KeyTotalRow = {
	requests: 0,
	promptTokens: 0,
	completionTokens: 0,
	cost: 0,
	lastUsed: null,
}

/** One live key's row: quotas, budget, aggregates. */
function liveRow(
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
function orphanRow(orphan: ReturnType<typeof mergeOrphanUsage>): KeyUsageRow {
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

export function makeKeyUsageReport(deps: KeyUsageDeps) {
	/**
	 * A host that never received the query port is a wiring fault, not an empty report.
	 *
	 * Answering `{keys: []}` here would render as "no API keys yet" on a install that has
	 * plenty, and the operator would go looking at their keys instead of at the wiring. The
	 * ports are `required()` in the factory for exactly this reason; this narrows the type.
	 */
	const aggregatesOf = deps.aggregatesOf
	if (!aggregatesOf) throw keyUsageFailed(new Error("keyUsage.aggregatesOf was not supplied"))

	return {
		async report(session: unknown, ownKey: string | null): Promise<KeyUsageReport> {
			const allKeys = await deps.listKeys()
			// The same visibility rule as the endpoint list: an API-key session sees its own key
			// plus the keys it created, and never another branch's names, quotas or model scopes.
			const keys = deps.visibleKeys(allKeys, session)
			const now = deps.now()
			const today = deps.todayKey()

			const aggregates = await aggregatesOf({ ownKey, keys, now })
			const rows: KeyUsageRow[] = keys.map((key) =>
				liveRow(key, allKeys, aggregates, deps, now, today),
			)

			if (shouldReportOrphanUsage(ownKey)) {
				const known = new Set(keys.map((key) => key.key))
				const orphan = Object.keys(aggregates.totals).filter((raw) => raw && !known.has(raw))
				if (orphan.length > 0) {
					rows.push(
						orphanRow(
							mergeOrphanUsage(orphan, aggregates.totals, aggregates.errorsByKey, aggregates.modelsByKey),
						),
					)
				}
			}

			rows.sort(compareKeyReportRows)
			return { keys: rows, generatedAt: new Date(now).toISOString() }
		},
	}
}

export type KeyUsage = ReturnType<typeof makeKeyUsageReport>

/** A refused read is a fault here, never the caller's mistake. */
export function keyUsageFailed(cause: unknown): AppError {
	return new AppError("INTERNAL", "Failed to load per-key usage", { cause })
}
