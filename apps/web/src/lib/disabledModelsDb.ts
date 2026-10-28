// Shim → re-export from new SQLite-based DB layer (src/lib/db/)
export {
	disableModels,
	enableModels,
	getDisabledByProvider,
	getDisabledModels,
} from "@9router/db/index"
