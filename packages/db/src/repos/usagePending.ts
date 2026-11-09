/**
 * Live pending-request tracking.
 *
 * Extracted verbatim from usageRepo.ts.
 */

import { labelForResolved } from "../helpers/modelLabel.ts"

import { matchesAllowedModels as matchesModelPatterns, parseAllowedModels } from "./apiKeysRepo.ts"
import { ensureRingInitialized, getConnectionMapCached } from "./usageDayRollup.ts"
import {
	lastErrorProvider,
	PENDING_TIMEOUT_MS,
	pendingRequests,
	pendingTimers,
	recentRing,
	scheduleStatsEvent,
	statsEmitter,
} from "./usageState.ts"
import type { ActiveRequest, RecentRequest } from "./usageTypes.ts"

export function trackPendingRequest(
	model: string,
	provider: string | null | undefined,
	connectionId: string | null | undefined,
	started: boolean,
	error = false,
): void {
	const modelKey = provider ? `${model} (${provider})` : model
	const timerKey = `${connectionId}|${modelKey}`

	if (!pendingRequests.byModel[modelKey]) pendingRequests.byModel[modelKey] = 0
	pendingRequests.byModel[modelKey] = Math.max(
		0,
		pendingRequests.byModel[modelKey] + (started ? 1 : -1),
	)
	if (pendingRequests.byModel[modelKey] === 0) delete pendingRequests.byModel[modelKey]

	if (connectionId) {
		if (!pendingRequests.byAccount[connectionId]) pendingRequests.byAccount[connectionId] = {}
		if (!pendingRequests.byAccount[connectionId][modelKey])
			pendingRequests.byAccount[connectionId][modelKey] = 0
		pendingRequests.byAccount[connectionId][modelKey] = Math.max(
			0,
			pendingRequests.byAccount[connectionId][modelKey] + (started ? 1 : -1),
		)
		if (pendingRequests.byAccount[connectionId][modelKey] === 0) {
			delete pendingRequests.byAccount[connectionId][modelKey]
			if (Object.keys(pendingRequests.byAccount[connectionId]).length === 0) {
				delete pendingRequests.byAccount[connectionId]
			}
		}
	}

	if (started) {
		clearTimeout(pendingTimers[timerKey])
		pendingTimers[timerKey] = setTimeout(() => {
			delete pendingTimers[timerKey]
			if (pendingRequests.byModel[modelKey] > 0) pendingRequests.byModel[modelKey] = 0
			if (connectionId && pendingRequests.byAccount[connectionId]?.[modelKey] > 0) {
				pendingRequests.byAccount[connectionId][modelKey] = 0
			}
			scheduleStatsEvent("pending")
		}, PENDING_TIMEOUT_MS)
	} else {
		clearTimeout(pendingTimers[timerKey])
		delete pendingTimers[timerKey]
	}

	if (!started && error && provider) {
		lastErrorProvider.provider = provider.toLowerCase()
		lastErrorProvider.ts = Date.now()
	}

	// [PENDING] console line removed; lifecycle is visible via "▶" and "📊 done" lines
	scheduleStatsEvent("pending")
}

// Scoped variant for API-key dashboard sessions. Without a filter this returns the
// global view; with one, live rows another key triggered are never exposed and the
// history is narrowed to the key plus its allowed models. Pending traffic carries no
// key attribution, so a scoped caller gets an empty active list rather than a leak.

/** One minute of traffic on the "last 10 minutes" sparkline. */

export async function getActiveRequests(
	filterApiKey: string | null = null,
	allowedModels = "*",
): Promise<{
	activeRequests: ActiveRequest[]
	recentRequests: RecentRequest[]
	errorProvider: string
}> {
	const activeRequests: ActiveRequest[] = []
	const connectionMap = await getConnectionMapCached()

	if (!filterApiKey) {
		for (const [connectionId, models] of Object.entries(pendingRequests.byAccount)) {
			for (const [modelKey, count] of Object.entries(models)) {
				if (count > 0) {
					const accountName = connectionMap[connectionId] || `Account ${connectionId.slice(0, 8)}...`
					const match = modelKey.match(/^(.*) \((.*)\)$/)
					activeRequests.push({
						model: match ? match[1] : modelKey,
						provider: match ? match[2] : "unknown",
						account: accountName,
						count,
					})
				}
			}
		}
	}

	const patterns = parseAllowedModels(allowedModels)
	const modelAllowed = (model: string) => matchesModelPatterns(patterns, model)

	await ensureRingInitialized()
	const recentRequests = [...recentRing.items]
		.filter((e) => !filterApiKey || e.apiKey === filterApiKey)
		.filter((e) => modelAllowed(String(e.model ?? "")))
		.sort((a, b) => Number(new Date(String(b.timestamp))) - Number(new Date(String(a.timestamp))))
		.map((e): RecentRequest => {
			const t = e.tokens || {}
			// The live stream is an operational view: an operator scanning it needs to
			// know which upstream actually served the call, not which combo abstracted
			// it. The ring stores that pair as fields, so it is already resolved here.
			const label = labelForResolved(e.model, (e as { resolvedModel?: string | null }).resolvedModel)
			return {
				timestamp: String(e.timestamp),
				model: label.display,
				requestedModel: label.alias,
				provider: e.provider || "",
				promptTokens: t.prompt_tokens || t.input_tokens || 0,
				completionTokens: t.completion_tokens || t.output_tokens || 0,
				cachedTokens: t.cached_tokens || t.cache_read_input_tokens || 0,
				status: e.status || "ok",
			}
		})
		.filter((e) => e.promptTokens > 0 || e.completionTokens > 0)
		.slice(0, 20)

	const errorProvider =
		!filterApiKey && Date.now() - lastErrorProvider.ts < 10000 ? lastErrorProvider.provider : ""
	return { activeRequests, recentRequests, errorProvider }
}

/**
 * usageHistory has no natural size bound: one row per request, forever, and
 * nothing ever deletes them (requestDetails has maxRecords, this table had
 * nothing). On a gateway that runs for months that is an unbounded file.
 *
 * Nothing reads a raw row older than 60 days: getUsageStats/getChartData answer
 * 24h/7d/30d/60d from usageHistory and everything longer from the usageDaily
 * rollup, while lifetime totals live in _meta. So rows past the retention window
 * are dead weight.
 *
 * Runs opportunistically from the write path (at most once an hour) rather than a
 * timer, so it costs nothing on a gateway that is not taking traffic.
 */
