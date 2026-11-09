// Public API barrel - all DB functions

import { keyAccessFromColumns } from "@9router/db/shared/keyAccess"
import { normalizeAllowedEndpoints } from "@9router/db/shared/keyEndpoints"
import { getAdapter } from "./driver.ts"
import { parseJson } from "./helpers/jsonCol.ts"
import { invalidateApiKeyCache } from "./repos/apiKeysRepo.ts"
import { invalidateNodeCache } from "./repos/nodesRepo.ts"
import { invalidatePricingCache } from "./repos/pricingRepo.ts"
import { invalidateSettingsCache } from "./repos/settingsRepo.ts"
import { sectionsPresent } from "./restoreSections.ts"

export { exportDb } from "./dbExport.ts"
export { importDb, importDbProgressive } from "./dbImport.ts"
export { getDbSummary } from "./dbSummary.ts"
export type {
	ApiKeyBackupRow,
	ComboBackup,
	CustomModelBackup,
	DbExportPayload,
	ExportScope,
	ImportProgress,
	ProviderConnectionBackup,
	ProviderNodeBackup,
	ProxyPoolBackup,
	UsageDailyBackupRow,
	UsageHistoryBackupRow,
} from "./dbTypes.ts"
// Aliases (model + custom + mitm)
export {
	addCustomModel,
	deleteCustomModel,
	deleteModelAlias,
	getCustomModels,
	getMitmAlias,
	getModelAliases,
	setMitmAliasAll,
	setModelAlias,
} from "./repos/aliasRepo.ts"
// API keys
export {
	createApiKey,
	deleteApiKey,
	getApiKeyById,
	getApiKeyByKey,
	getApiKeys,
	recordApiKeyUsageInWindow,
	updateApiKey,
	validateApiKey,
} from "./repos/apiKeysRepo.ts"
// Persistent prompt cache (the kv table, so a cache hit survives a restart)
export {
	dropCacheEntry,
	dropCacheScope,
	pruneCacheScope,
	readCacheScope,
	writeCacheEntry,
} from "./repos/cacheRepo.ts"
// Combos
export {
	createCombo,
	deleteCombo,
	getComboById,
	getComboByName,
	getCombos,
	updateCombo,
} from "./repos/combosRepo.ts"
// Provider connections
export {
	cleanupProviderConnections,
	createProviderConnection,
	deleteProviderConnection,
	deleteProviderConnectionsByProvider,
	getProviderConnectionById,
	getProviderConnections,
	reorderProviderConnections,
	updateProviderConnection,
} from "./repos/connectionsRepo.ts"
// Disabled models
export {
	disableModels,
	enableModels,
	getDisabledByProvider,
	getDisabledModels,
} from "./repos/disabledModelsRepo.ts"
// Error Logs
export {
	clearErrorLogs,
	getErrorLogs,
	recordErrorLog,
} from "./repos/errorLogRepo.ts"
// Model overrides + custom model (studio) virtual models
export {
	deleteModelOverride,
	deleteStudioModel,
	getModelOverrides,
	getStudioModel,
	getStudioModels,
	setModelOverride,
	setStudioModel,
} from "./repos/modelEditorRepo.ts"
// Provider nodes
export {
	createProviderNode,
	deleteProviderNode,
	getProviderNodeById,
	getProviderNodes,
	updateProviderNode,
} from "./repos/nodesRepo.ts"
// Pricing
export {
	getPricing,
	getPricingForModel,
	resetAllPricing,
	resetPricing,
	updatePricing,
} from "./repos/pricingRepo.ts"
// Proxy pools
export {
	createProxyPool,
	deleteProxyPool,
	deleteProxyPools,
	getProxyPoolById,
	getProxyPools,
	updateProxyPool,
} from "./repos/proxyPoolsRepo.ts"
// Request details
export {
	getDistinctProviders,
	getRequestDetailById,
	getRequestDetails,
	saveRequestDetail,
} from "./repos/requestDetailsRepo.ts"
// Settings
export {
	exportSettings,
	getCloudUrl,
	getSettings,
	isCloudEnabled,
	updateSettings,
} from "./repos/settingsRepo.ts"
export type {
	HourlySpendQuery,
	HourlySpendRow,
	LatencySample,
	LatencySampleQuery,
} from "./repos/usageRepo.ts"
// Usage
export {
	appendRequestLog,
	flushDayRollup,
	getActiveRequests,
	getChartData,
	getHourlySpend,
	getLatencySamples,
	getRecentLogs,
	getSparks,
	getUsageHistory,
	getUsageStats,
	saveRequestUsage,
	statsEmitter,
	trackPendingRequest,
} from "./repos/usageRepo.ts"
export async function initDb() {
	await getAdapter()
}
