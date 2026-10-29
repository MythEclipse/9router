/**
 * Adapter for {@link UsageReportPort}.
 *
 * `apps/web`'s `usageDb` is a shim over `@9router/db`, which this package can
 * import directly — so this is a thin passthrough and the only thing it adds is
 * narrowing the untyped rows.
 */

import {
	getChartData,
	getRecentLogs,
	getSparks,
	getUsageHistory,
	getUsageStats,
} from "@9router/db/index"
import type { UsageHistoryRow, UsageReportPort } from "../../../application/usage/report-usage.ts"

export function createUsageReportPort(): UsageReportPort {
	return {
		async stats(period, apiKeyFilter, allowedModels) {
			return getUsageStats(period, apiKeyFilter, allowedModels)
		},
		async chart(period, apiKeyFilter, allowedModels) {
			return getChartData(period, apiKeyFilter, allowedModels)
		},
		async sparks(period, apiKeyFilter, allowedModels) {
			return getSparks(period, apiKeyFilter, allowedModels)
		},
		async history(filter) {
			const rows = await getUsageHistory(filter)
			return rows as unknown as readonly UsageHistoryRow[]
		},
		async recentLogs(limit) {
			return getRecentLogs(limit)
		},
	}
}
