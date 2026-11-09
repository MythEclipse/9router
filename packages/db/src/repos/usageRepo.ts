/**
 * Usage repository — barrel.
 *
 * Implementation lives in per-responsibility modules:
 * - usageTypes.ts — shared interfaces
 * - usageState.ts — process-shared state and small helpers
 * - usageDayRollup.ts — day aggregation, staging and flush
 * - usagePending.ts — pending-request tracking
 * - usageHistory.ts — write path and history reads
 * - usageRecent.ts / usageRecentMapper.ts — stats accumulation helpers
 * - usageStatsMain.ts — getUsageStats aggregate
 * - usageChart.ts / usageSparks.ts — chart and spark readers
 * - usageLogs.ts / usageMetrics.ts — request log, latency and spend readers
 *
 * Every name is re-exported here so existing `from "./usageRepo.ts"` (and
 * `@9router/db/repos/usageRepo`) importers keep working.
 */

export { getChartData } from "./usageChart.ts"
export { flushDayRollup } from "./usageDayRollup.ts"
export { __test__, getUsageHistory, saveRequestUsage } from "./usageHistory.ts"
export type { RequestLogEntry } from "./usageLogs.ts"
export { appendRequestLog, getRecentLogs } from "./usageLogs.ts"
export type {
	HourlySpendQuery,
	HourlySpendRow,
	LatencySample,
	LatencySampleQuery,
} from "./usageMetrics.ts"
export { getHourlySpend, getLatencySamples } from "./usageMetrics.ts"
export { getActiveRequests, trackPendingRequest } from "./usagePending.ts"
export { mapRecentRequests } from "./usageRecentMapper.ts"
export { getSparks } from "./usageSparks.ts"
export { statsEmitter } from "./usageState.ts"
export { getUsageStats } from "./usageStatsMain.ts"
export type {
	AccountUsageCounter,
	ActiveRequest,
	ApiKeyLabel,
	ChartBucket,
	ModelUsageCounter,
	RecentRequest,
	UsageBucket,
	UsageCounter,
	UsageCounters,
	UsageDay,
	UsageEntry,
	UsageHistoryFilter,
	UsageHistoryRecord,
	UsageStats,
	UsageTokens,
} from "./usageTypes.ts"
