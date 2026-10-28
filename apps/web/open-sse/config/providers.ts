// Barrel: PROVIDERS now built from providers/registry (transport co-located with models)
import { PROVIDERS } from "../providers/index.ts"
import type { Credentials } from "../types.ts"

export { PROVIDER_OAUTH, PROVIDERS } from "../providers/index.ts"

export const OLLAMA_LOCAL_DEFAULT_HOST = "http://localhost:11434"

export function resolveOllamaLocalHost(credentials?: Credentials | null) {
	const raw = credentials?.providerSpecificData?.baseUrl?.trim()
	return (raw || OLLAMA_LOCAL_DEFAULT_HOST).replace(/\/$/, "")
}

// Region URLs single-source from registry xiaomi-tokenplan.transport
export const XIAOMI_TOKENPLAN_REGIONS = PROVIDERS["xiaomi-tokenplan"]?.regions || {}
export const XIAOMI_TOKENPLAN_DEFAULT_REGION = PROVIDERS["xiaomi-tokenplan"]?.defaultRegion

export function resolveXiaomiTokenplanBaseUrl(credentials) {
	const region = credentials?.providerSpecificData?.region
	return (
		XIAOMI_TOKENPLAN_REGIONS[region] || XIAOMI_TOKENPLAN_REGIONS[XIAOMI_TOKENPLAN_DEFAULT_REGION]
	)
}
