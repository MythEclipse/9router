// Shim → re-export from new SQLite-based DB layer (src/lib/db/)
export {
	getDistinctProviders,
	getRequestDetailById,
	getRequestDetails,
	saveRequestDetail,
} from "@/lib/db/index"
