// Shim → re-export from new SQLite-based DB layer (src/lib/db/)
export {
	appendRequestLog,
	getActiveRequests,
	getChartData,
	getRecentLogs,
	getRequestDetailById,
	getRequestDetails,
	getSparks,
	getUsageHistory,
	getUsageStats,
	saveRequestDetail,
	saveRequestUsage,
	statsEmitter,
	trackPendingRequest,
} from "@/lib/db/index"
