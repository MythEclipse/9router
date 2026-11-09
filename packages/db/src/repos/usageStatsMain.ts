/**
 * Usage stats aggregate.
 *
 * Extracted verbatim from usageRepo.ts.
 */

import { getAdapter } from "../driver.ts"
import { parseJson } from "../helpers/jsonCol.ts"
import type { DbRow } from "../types.ts"

import { matchesAllowedModels as matchesModelPatterns, parseAllowedModels } from "./apiKeysRepo.ts"
import { accumulate, emptyTotals, keepNewest, sumTotals } from "./usageCounters.ts"
import { emptyDay, flushDayRollupQuietly } from "./usageDayRollup.ts"
import {
	buildApiKeyMaps,
	buildConnectionMap,
	buildProviderNodeNameMap,
	type ProviderNodeNameMap,
} from "./usageLookups.ts"
import {
	accumulateHistoryRow,
	buildLastTenMinutes,
	type CounterRow,
	foldPendingRollupRows,
	loadDaysInRange,
	periodCutoff,
} from "./usageRecent.ts"
import { mapRecentRequests } from "./usageRecentMapper.ts"
import {
	apiKeyBucketId,
	type ConnectionMap,
	lastErrorProvider,
	maskApiKey,
	PERIOD_MS,
	pendingRequests,
} from "./usageState.ts"
import type { UsageCounter, UsageDay, UsageStats } from "./usageTypes.ts"

export async function getUsageStats(
	period = "all",
	filterApiKey: string | null = null,
	allowedModels = "*",
): Promise<UsageStats> {
	const db = await getAdapter()

	foldPendingRollupRows(db)

	const patterns = parseAllowedModels(allowedModels)
	const modelAllowed = (model: string) => matchesModelPatterns(patterns, model)

	const [{ getProviderConnections }, { getApiKeys }, { getProviderNodes }] = await Promise.all([
		import("./connectionsRepo.ts"),
		import("./apiKeysRepo.ts"),
		import("./nodesRepo.ts"),
	])

	let allConnections: Awaited<ReturnType<typeof getProviderConnections>> = []
	try {
		allConnections = await getProviderConnections()
	} catch (e) {
		// Without these the report groups every row under an unknown connection.
		console.error("[usage] failed to load connections for the report:", e)
	}
	// The builder reads `id`, `name` and `email`; passing the records whole makes
	// the structural check fail on their index signatures.
	const connectionMap: ConnectionMap = buildConnectionMap(
		allConnections.map((c) => ({ id: c.id, name: c.name ?? undefined, email: c.email ?? undefined })),
	)

	let providerNodeNameMap: ProviderNodeNameMap = {}
	try {
		providerNodeNameMap = buildProviderNodeNameMap(
			(await getProviderNodes()).map((n) => ({ id: n.id, name: n.name ?? undefined })),
		)
	} catch (e) {
		// Node names then fall back to the connection name.
		console.error("[usage] failed to load provider nodes for the report:", e)
	}

	let allApiKeys: Awaited<ReturnType<typeof getApiKeys>> = []
	try {
		allApiKeys = await getApiKeys()
	} catch (e) {
		// Rows then show the stored key hash instead of the key's display name.
		console.error("[usage] failed to load api keys for the report:", e)
	}
	const { byKey: apiKeyMap, byBucketId: apiKeyBucketMap } = buildApiKeyMaps(
		allApiKeys,
		apiKeyBucketId,
	)

	// Read enough recent rows to account for filtered lifecycle/zero-usage entries.
	// `meta` must come along: the `model` column holds the requested name (a combo
	// survives there) and the real target rides in `meta.resolvedModel`, so a row
	// mapped without it reports the combo as if it were a model.
	const recentSql = filterApiKey
		? `SELECT timestamp, provider, model, tokens, status, meta FROM usageHistory WHERE apiKey = ? ORDER BY id DESC LIMIT 100`
		: `SELECT timestamp, provider, model, tokens, status, meta FROM usageHistory ORDER BY id DESC LIMIT 100`
	const recentParams = filterApiKey ? [filterApiKey] : []
	const recentRows = db.all<DbRow>(recentSql, recentParams)
	const recentRequests = mapRecentRequests(recentRows, { limit: 20, isModelAllowed: modelAllowed })

	const stats: UsageStats = {
		totalRequests: 0,
		totalPromptTokens: 0,
		totalCompletionTokens: 0,
		totalCachedTokens: 0,
		totalCost: 0,
		byProvider: {},
		byModel: {},
		byAccount: {},
		byApiKey: {},
		byEndpoint: {},
		last10Minutes: [],
		pending: filterApiKey ? {} : pendingRequests,
		activeRequests: filterApiKey ? [] : [],
		recentRequests,
		errorProvider: Date.now() - lastErrorProvider.ts < 10000 ? lastErrorProvider.provider : "",
	}

	// Active requests - only populate for global view, or filter for specific key
	if (!filterApiKey) {
		for (const [connectionId, models] of Object.entries(pendingRequests.byAccount)) {
			for (const [modelKey, count] of Object.entries(models)) {
				if (count > 0) {
					const accountName = connectionMap[connectionId] || `Account ${connectionId.slice(0, 8)}...`
					const match = modelKey.match(/^(.*) \((.*)\)$/)
					stats.activeRequests.push({
						model: match ? match[1] : modelKey,
						provider: match ? match[2] : "unknown",
						account: accountName,
						count,
					})
				}
			}
		}
	}

	stats.last10Minutes = buildLastTenMinutes(db, filterApiKey, modelAllowed)

	if (filterApiKey) {
		const cutoff = periodCutoff(period)

		const where: string[] = ["apiKey = ?", "status = 'ok'"]
		const params: unknown[] = [filterApiKey]
		if (cutoff) {
			where.push("timestamp >= ?")
			params.push(cutoff)
		}

		const filtered = db.all<DbRow>(
			`SELECT timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, tokens, meta FROM usageHistory WHERE ${where.join(" AND ")}`,
			params,
		)

		for (const r of filtered) {
			if (!modelAllowed(String(r.model ?? ""))) continue
			accumulateHistoryRow(
				stats,
				r,
				{ connectionMap, providerNodeNameMap, apiKeyMap },
				{ includeUnkeyedRows: false },
			)
		}
		stats.totalRequests = (Object.values(stats.byProvider) as UsageCounter[]).reduce(
			(sum, p) => sum + (p.requests || 0),
			0,
		)
		return stats
	}

	const useDailySummary = period !== "24h" && period !== "today"

	if (useDailySummary) {
		const periodDays: Record<string, number> = { "7d": 7, "30d": 30, "60d": 60 }
		const maxDays: number | null = periodDays[period] || null
		const dayRows = loadDaysInRange(db, maxDays)

		for (const dr of dayRows) {
			const dateKey = dr.dateKey
			const day = parseJson<UsageDay>(dr.data, emptyDay())
			if (patterns === null) {
				stats.totalPromptTokens += day.promptTokens || 0
				stats.totalCompletionTokens += day.completionTokens || 0
				stats.totalCachedTokens += day.cachedTokens || 0
				stats.totalCost += day.cost || 0

				for (const [prov, p] of Object.entries(day.byProvider || {}) as Array<[string, UsageCounter]>) {
					accumulate(
						stats.byProvider as Record<string, CounterRow>,
						prov,
						() => ({ ...emptyTotals() }),
						p,
					)
				}
			}

			for (const [mk, m] of Object.entries(day.byModel || {})) {
				const rawModel = m.rawModel || mk.split("|")[0]
				if (!modelAllowed(rawModel)) continue
				const provider = m.provider || mk.split("|")[1] || ""
				const statsKey = provider ? `${rawModel} (${provider})` : rawModel
				const providerDisplayName = providerNodeNameMap[provider] || provider
				const modelCounter = accumulate(
					stats.byModel as Record<string, CounterRow>,
					statsKey,
					() => ({
						...emptyTotals(),
						rawModel,
						provider: providerDisplayName,
						resolvedModel: m.resolvedModel || undefined,
						lastUsed: dateKey,
					}),
					m,
				)
				keepNewest(modelCounter, "lastUsed", dateKey)

				// Day totals and provider buckets carry no model dimension, so in
				// restricted mode they are rebuilt from the matching model buckets.
				if (patterns !== null) {
					stats.totalPromptTokens += m.promptTokens || 0
					stats.totalCompletionTokens += m.completionTokens || 0
					stats.totalCachedTokens += m.cachedTokens || 0
					stats.totalCost += m.cost || 0

					if (provider) {
						accumulate(
							stats.byProvider as Record<string, CounterRow>,
							provider,
							() => ({ ...emptyTotals() }),
							m,
						)
					}
				}
			}

			for (const [acctKey, a] of Object.entries(day.byAccount || {})) {
				// byAccount keys are `connectionId|model|provider`; databases written
				// before that shape hold a bare connectionId with a single rawModel that
				// absorbed every model's tokens. Parse both so an upgrade reads its own
				// history instead of showing "Account undefined...".
				const [connId, _keyModel, _keyProvider] = acctKey.split("|")
				const accountName = connectionMap[connId] || `Account ${connId.slice(0, 8)}...`
				const rawModel = a.rawModel || ""
				if (!modelAllowed(rawModel)) continue
				const provider = a.provider || ""
				const providerDisplayName = providerNodeNameMap[provider] || provider
				const accountKey = `${rawModel} (${provider} - ${accountName})`
				const accountCounter = accumulate(
					stats.byAccount as Record<string, CounterRow>,
					accountKey,
					() => ({
						...emptyTotals(),
						rawModel,
						provider: providerDisplayName,
						connectionId: connId,
						accountName,
						lastUsed: dateKey,
					}),
					a,
				)
				keepNewest(accountCounter, "lastUsed", dateKey)
			}

			for (const [akKey, ak] of Object.entries(day.byApiKey || {})) {
				const rawModel = ak.rawModel || ""
				if (!modelAllowed(rawModel)) continue
				const provider = ak.provider || ""
				const providerDisplayName = providerNodeNameMap[provider] || provider
				// `ak.apiKey` in usageDaily is already MASKED (see aggregateEntryToDay);
				// the raw key never touches this table. Resolve the key's display name
				// from the bucket id parsed out of the entry key instead, which is what
				// the bucket was built from.
				const bucketId = akKey.includes("|") ? akKey.split("|")[0] : null
				const keyInfo = bucketId ? apiKeyBucketMap[bucketId] : null
				// Legacy rows (written before the mask) still hold either a raw key or
				// "local-no-key" here; mask whatever survived so nothing replayable
				// reaches the wire.
				const storedKey = typeof ak.apiKey === "string" ? ak.apiKey : ""
				const apiKeyMasked =
					storedKey && storedKey !== "local-no-key"
						? storedKey.length > 12
							? maskApiKey(storedKey)
							: storedKey
						: null
				const keyName = keyInfo?.name || apiKeyMasked || "Local (No API Key)"
				const apiKeyKey = apiKeyMasked || "local-no-key"
				const apiKeyCounter = accumulate(
					stats.byApiKey as Record<string, CounterRow>,
					akKey,
					() => ({
						...emptyTotals(),
						rawModel,
						provider: providerDisplayName,
						apiKeyMasked,
						keyName,
						apiKeyKey,
						lastUsed: dateKey,
					}),
					ak,
				)
				keepNewest(apiKeyCounter, "lastUsed", dateKey)
			}

			for (const [epKey, ep] of Object.entries(day.byEndpoint || {})) {
				const endpoint = ep.endpoint || epKey.split("|")[0] || "Unknown"
				const rawModel = ep.rawModel || ""
				if (!modelAllowed(rawModel)) continue
				const provider = ep.provider || ""
				const providerDisplayName = providerNodeNameMap[provider] || provider
				const endpointCounter = accumulate(
					stats.byEndpoint as Record<string, CounterRow>,
					epKey,
					() => ({
						...emptyTotals(),
						endpoint,
						rawModel,
						provider: providerDisplayName,
						lastUsed: dateKey,
					}),
					ep,
				)
				keepNewest(endpointCounter, "lastUsed", dateKey)
			}
		}

		// Overlay precise lastUsed timestamps from history.
		// ponytail: overlay scans only a recent window; entries older than that keep
		// day-level lastUsed from usageDaily. Upgrade to a materialized per-key
		// MAX(timestamp) table if exact old timestamps ever matter.
		const OVERLAY_WINDOW_MS = 2 * 86400000
		const overlayCutoff = Math.max(
			maxDays ? Date.now() - maxDays * 86400000 : 0,
			Date.now() - OVERLAY_WINDOW_MS,
		)
		const histRows = db.all<DbRow>(
			`SELECT timestamp, provider, model, connectionId, apiKey, endpoint FROM usageHistory WHERE timestamp >= ?`,
			[new Date(overlayCutoff).toISOString()],
		)
		for (const e of histRows) {
			const ts = String(e.timestamp ?? "")
			const histModel = String(e.model ?? "")
			const histProvider = String(e.provider ?? "")
			const histConnectionId = e.connectionId ? String(e.connectionId) : null
			if (!modelAllowed(histModel)) continue
			const modelKey = histProvider ? `${histModel} (${histProvider})` : histModel
			if (stats.byModel[modelKey] && new Date(ts) > new Date(stats.byModel[modelKey].lastUsed ?? 0))
				stats.byModel[modelKey].lastUsed = ts

			if (histConnectionId) {
				const accountName =
					connectionMap[histConnectionId] || `Account ${histConnectionId.slice(0, 8)}...`
				const accountKey = `${histModel} (${histProvider} - ${accountName})`
				const account = stats.byAccount[accountKey]
				if (account && new Date(ts) > new Date(account.lastUsed ?? 0)) account.lastUsed = ts
			}

			const rawHistKey = e.apiKey && typeof e.apiKey === "string" ? e.apiKey : null
			const apiKeyKey = rawHistKey
				? `${apiKeyBucketId(rawHistKey)}|${histModel}|${histProvider || "unknown"}`
				: "local-no-key"
			const keyCounter = stats.byApiKey[apiKeyKey]
			if (keyCounter && new Date(ts) > new Date(keyCounter.lastUsed ?? 0)) keyCounter.lastUsed = ts

			const endpoint = String(e.endpoint ?? "") || "Unknown"
			const endpointKey = `${endpoint}|${histModel}|${histProvider || "unknown"}`
			if (
				stats.byEndpoint[endpointKey] &&
				new Date(ts) > new Date(stats.byEndpoint[endpointKey].lastUsed ?? 0)
			)
				stats.byEndpoint[endpointKey].lastUsed = ts
		}
	} else {
		// 24h / today: live history is the precise source.
		let cutoff
		if (period === "today") {
			const startOfDay = new Date()
			startOfDay.setHours(0, 0, 0, 0)
			cutoff = startOfDay.toISOString()
		} else {
			cutoff = new Date(Date.now() - PERIOD_MS["24h"]).toISOString()
		}
		const filtered = db.all(
			`SELECT timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, tokens, meta FROM usageHistory WHERE timestamp >= ? AND status = 'ok'`,
			[cutoff],
		)

		for (const r of filtered) {
			if (!modelAllowed(String(r.model ?? ""))) continue
			accumulateHistoryRow(
				stats,
				r,
				{ connectionMap, providerNodeNameMap, apiKeyMap },
				{ includeUnkeyedRows: true },
			)
		}
	}

	stats.totalRequests = sumTotals(Object.values(stats.byProvider) as UsageCounter[]).requests
	return stats
}
