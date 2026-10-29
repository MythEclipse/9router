/**
 * Adapter: the provider-connection stores, seen through the use-case's ports.
 *
 * Every method here is a one-line delegation. That is the point — the decision
 * lives in `application/providers/manage-connections.ts`, and this file exists
 * only so `apps/api` can reach tables it does not own without importing
 * `apps/web` (which carries path aliases and `open-sse` that this project's
 * TypeScript cannot resolve).
 */

import type {
	ConnectionFields,
	ConnectionNode,
	ConnectionNodeStore,
	ConnectionStore,
	ModelListAdapter,
	ProviderCatalogue,
	ProxyPoolStore,
	StoredConnection,
} from "../../../application/providers/ports.ts"

/** The functions `apps/web` hands over. Each maps straight onto a store call. */
export interface ConnectionHost {
	readonly connections: {
		list(filter?: { provider?: string; isActive?: boolean }): Promise<StoredConnection[]>
		find(id: string): Promise<StoredConnection | null>
		create(fields: ConnectionFields): Promise<StoredConnection>
		update(id: string, fields: Partial<ConnectionFields>): Promise<StoredConnection | null>
		remove(id: string): Promise<boolean>
	}
	readonly nodes: {
		find(id: string): Promise<ConnectionNode | null>
		list(): Promise<ConnectionNode[]>
	}
	readonly pools: {
		exists(id: string): Promise<boolean>
	}
}

export function createConnectionStore(host: ConnectionHost): ConnectionStore {
	return {
		list: (filter) => host.connections.list(filter),
		find: (id) => host.connections.find(id),
		create: (fields) => host.connections.create(fields),
		update: (id, fields) => host.connections.update(id, fields),
		remove: (id) => host.connections.remove(id),
	}
}

export function createConnectionNodeStore(host: ConnectionHost): ConnectionNodeStore {
	return {
		find: (id) => host.nodes.find(id),
		list: () => host.nodes.list(),
	}
}

export function createProxyPoolStore(host: ConnectionHost): ProxyPoolStore {
	return {
		exists: (id) => host.pools.exists(id),
	}
}

/**
 * The provider catalogue.
 *
 * `isCreatable` is the union the create route spelled out inline: a provider may
 * be written when it is an API-key provider, a free-tier provider, declares an
 * `apikey` auth mode, stores a web cookie, or names a compatible node.
 */
export function createProviderCatalogue(input: {
	readonly label: (provider: string) => string | undefined
	readonly isOpenAICompatible: (provider: string) => boolean
	readonly isAnthropicCompatible: (provider: string) => boolean
	readonly isCustomEmbedding: (provider: string) => boolean
	readonly isWebCookie: (provider: string) => boolean
	readonly acceptsApiKey: (provider: string) => boolean
	readonly isFreeTier: (provider: string) => boolean
	readonly apiKeySubstituteField: (provider: string) => string | null
	readonly usesAwsCredentialForm: (provider: string) => boolean
	readonly modelListAdapter: (provider: string) => ModelListAdapter
}): ProviderCatalogue {
	return {
		label: (provider) => input.label(provider) ?? provider,
		isOpenAICompatible: input.isOpenAICompatible,
		isAnthropicCompatible: input.isAnthropicCompatible,
		isCustomEmbedding: input.isCustomEmbedding,
		isWebCookie: input.isWebCookie,
		apiKeySubstituteField: input.apiKeySubstituteField,
		usesAwsCredentialForm: input.usesAwsCredentialForm,
		modelListAdapter: input.modelListAdapter,
		isCreatable: (provider) =>
			!!provider &&
			(input.acceptsApiKey(provider) ||
				input.isFreeTier(provider) ||
				input.isWebCookie(provider) ||
				input.isOpenAICompatible(provider) ||
				input.isAnthropicCompatible(provider) ||
				input.isCustomEmbedding(provider)),
	}
}
