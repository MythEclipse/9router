/**
 * API-keys repository — barrel.
 */

export {
	buildAllowedModelsSql,
	matchesAllowedModels,
	parseAllowedModels,
} from "./allowedModels.ts"
export {
	createApiKey,
	deleteApiKey,
	getApiKeyById,
	getApiKeyByKey,
	getApiKeys,
	updateApiKey,
} from "./apiKeysCrud.ts"
export type { ApiKeyRecord } from "./apiKeysTypes.ts"
export { parsePermissions, utcDayKey } from "./apiKeysTypes.ts"
export type { ApiKeyVerdict, RateLimitVerdict } from "./apiKeysValidate.ts"
export {
	getAllowedModelsOfKey,
	invalidateApiKeyCache,
	reconcileAllowedModels,
	recordApiKeyUsageInWindow,
	validateApiKey,
} from "./apiKeysValidate.ts"
