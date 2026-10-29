/**
 * The provider-connection host.
 *
 * `apps/api` cannot import these modules itself: `apps/web` resolves `@/` aliases
 * and `open-sse/` that this project's TypeScript does not know. So the owning
 * app supplies them as functions and the use-case only sees ports.
 */

import type { ConnectionHost } from "9router-api/infrastructure/db/repositories/provider-connection-repository"
import { createProviderCatalogue } from "9router-api/infrastructure/db/repositories/provider-connection-repository"
import {
	createProviderConnection,
	deleteProviderConnection,
	getProviderConnectionById,
	getProviderConnections,
	getProviderNodeById,
	getProviderNodes,
	getProxyPoolById,
	updateProviderConnection,
} from "@/models"
import { APIKEY_PROVIDERS } from "@/shared/constants/config"
import {
	AI_PROVIDERS,
	FREE_TIER_PROVIDERS,
	isAnthropicCompatibleProvider,
	isCustomEmbeddingProvider,
	isOpenAICompatibleProvider,
	WEB_COOKIE_PROVIDERS,
} from "@/shared/constants/providers"
import { toProviderConnectionResponse, usesAwsCredentialForm } from "./providerConnectionResponse"
import { normalizeProviderId, normalizeProviderSpecificData } from "./providerNormalization"

/** The three tables the connection use-case reads, as the stores expose them. */
export const connectionHost: ConnectionHost = {
	connections: {
		list: (filter) => getProviderConnections(filter),
		find: (id) => getProviderConnectionById(id),
		create: (fields) => createProviderConnection(fields),
		update: (id, fields) => updateProviderConnection(id, fields),
		remove: (id) => deleteProviderConnection(id),
	},
	nodes: {
		find: (id) => getProviderNodeById(id),
		list: () => getProviderNodes(),
	},
	pools: {
		exists: async (id) => !!(await getProxyPoolById(id)),
	},
}

/**
 * What kinds of provider exist.
 *
 * `acceptsApiKey` covers the API-key providers plus the dual-auth ones that live
 * under category `oauth` but declare an `apikey` auth mode — they are not in
 * `APIKEY_PROVIDERS`, so testing membership alone would refuse them.
 */
export const providerCatalogue = createProviderCatalogue({
	label: (provider) => AI_PROVIDERS[provider]?.name,
	isOpenAICompatible: isOpenAICompatibleProvider,
	isAnthropicCompatible: isAnthropicCompatibleProvider,
	isCustomEmbedding: isCustomEmbeddingProvider,
	isWebCookie: (provider) => !!WEB_COOKIE_PROVIDERS[provider],
	acceptsApiKey: (provider) =>
		!!APIKEY_PROVIDERS[provider] || !!AI_PROVIDERS[provider]?.authModes?.includes("apikey"),
	isFreeTier: (provider) => !!FREE_TIER_PROVIDERS[provider],
	apiKeySubstituteField: (provider) => AI_PROVIDERS[provider]?.apiKeyOptionalWith ?? null,
	usesAwsCredentialForm,
})

/** What the connection use-case needs beyond the tables. */
export const connectionResponse = toProviderConnectionResponse

export { normalizeProviderId, normalizeProviderSpecificData }
