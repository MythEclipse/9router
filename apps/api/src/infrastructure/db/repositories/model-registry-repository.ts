/**
 * Model-registry adapters.
 *
 * The four registries (aliases, disabled, custom, studio), the key reconcile step
 * and the provider tables are **supplied by the host** rather than imported.
 *
 * They live in `apps/web`, and this package cannot import that directory: the web
 * project uses `@/` path aliases and `open-sse/` imports that the API's
 * TypeScript project does not resolve. The host owns those modules already, so it
 * passes them in — the same pattern the pxpipe engine and the semantic cache use.
 *
 * The adapters below are shape translations only: they normalise the loose rows
 * the gateway's `localDb` returns into the narrow types the use-cases declare.
 */
export type { CatalogueHost } from "../../model-catalogue-port.ts"

import type {
	AllowedModelReconciler,
	ComboReaderPort,
	CustomModelPort,
	DisabledModelPort,
	ModelAliasPort,
	NodePrefixPort,
	ProviderConnectionPort,
	ProviderNodePort,
	StudioModelPort,
} from "../../../application/models/ports.ts"

/**
 * The stores the host must provide. Each is a module `apps/web` already imports;
 * there is no second implementation of any of them.
 */
export interface RegistryHost {
	aliases: {
		list(): Promise<unknown>
		set(alias: string, model: string): Promise<void>
		remove(alias: string): Promise<void>
	}
	disabled: {
		list(): Promise<unknown>
		disable(providerAlias: string, ids: string[]): Promise<void>
		/** An empty `ids` re-enables everything for that provider. */
		enable(providerAlias: string, ids: string[]): Promise<void>
	}
	customModels: {
		list(): Promise<unknown>
		add(fields: Record<string, unknown>): Promise<unknown>
		remove(fields: { providerAlias: string; id: string; type: string }): Promise<void>
	}
	studioModels: {
		list(): Promise<unknown>
		find(callName: string): Promise<unknown>
		save(fields: Record<string, unknown>): Promise<unknown>
		remove(callName: string): Promise<void>
	}
	reconcileAllowedModels(change: {
		removed?: string[]
		renamed?: Record<string, string>
	}): Promise<{ emptied?: string[] } | null>
	connections: {
		list(filter?: { provider?: string }): Promise<unknown>
		update(id: string, patch: Record<string, unknown>): Promise<unknown>
	}
	nodes: {
		list(): Promise<unknown>
		create(fields: Record<string, unknown>): Promise<unknown>
		update(id: string, patch: Record<string, unknown>): Promise<unknown>
		remove(id: string): Promise<void>
		removeConnections(providerId: string): Promise<void>
	}
	combos: { list(): Promise<unknown> }
}

function asRows(value: unknown): Array<Record<string, unknown>> {
	return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : []
}

export function createModelAliasPort(host: RegistryHost): ModelAliasPort {
	return {
		async list() {
			const rows = await host.aliases.list()
			return (rows && typeof rows === "object" ? rows : {}) as Record<string, string>
		},
		set: (alias, model) => host.aliases.set(alias, model),
		remove: (alias) => host.aliases.remove(alias),
	}
}

export function createDisabledModelPort(host: RegistryHost): DisabledModelPort {
	return {
		async list() {
			const rows = await host.disabled.list()
			return (rows && typeof rows === "object" ? rows : {}) as Record<string, string[]>
		},
		disable: (providerAlias, ids) => host.disabled.disable(providerAlias, ids),
		enable: (providerAlias, ids) => host.disabled.enable(providerAlias, ids),
	}
}

export function createCustomModelPort(host: RegistryHost): CustomModelPort {
	return {
		async list() {
			return asRows(await host.customModels.list())
		},
		add: (fields) => host.customModels.add(fields),
		remove: (fields) => host.customModels.remove(fields),
	}
}

export function createStudioModelPort(host: RegistryHost): StudioModelPort {
	return {
		async list() {
			return asRows(await host.studioModels.list())
		},
		async find(callName) {
			const row = await host.studioModels.find(callName)
			return row && typeof row === "object" ? (row as Record<string, unknown>) : null
		},
		save: (fields) => host.studioModels.save(fields),
		remove: (callName) => host.studioModels.remove(callName),
	}
}

export function createAllowedModelReconciler(host: RegistryHost): AllowedModelReconciler {
	return {
		async reconcile(change) {
			const result = await host.reconcileAllowedModels(change)
			return { emptied: result?.emptied ?? [] }
		},
	}
}

export function createProviderConnectionPort(host: RegistryHost): ProviderConnectionPort {
	return {
		async list(filter) {
			const rows = asRows(await host.connections.list(filter))
			return rows.map((row) => ({
				...row,
				id: String(row.id),
				provider: String(row.provider ?? ""),
			}))
		},
		update: (id, patch) => host.connections.update(id, patch),
	}
}

/**
 * Nodes are looked up through the list rather than a by-id call, so `find` and
 * `list` cannot disagree about the row shape — which is how an update once
 * patched a node whose `type` the reader had already normalised differently.
 */
export function createProviderNodePort(host: RegistryHost): ProviderNodePort {
	return {
		async list() {
			return asRows(await host.nodes.list()).map((row) => ({ ...row, id: String(row.id) }))
		},
		async find(id) {
			const rows = asRows(await host.nodes.list())
			const match = rows.find((row) => String(row.id) === id)
			return match ? { ...match, id } : null
		},
		async create(fields) {
			const created = (await host.nodes.create(fields)) as Record<string, unknown>
			return { ...created, id: String(created.id) }
		},
		async update(id, patch) {
			const updated = await host.nodes.update(id, patch)
			return updated && typeof updated === "object"
				? { ...(updated as Record<string, unknown>), id }
				: null
		},
		async remove(id) {
			await host.nodes.remove(id)
			return true
		},
		removeConnections: (providerId) => host.nodes.removeConnections(providerId),
	}
}

export function createComboReaderPort(host: RegistryHost): ComboReaderPort {
	return {
		async list() {
			return asRows(await host.combos.list()).map((row) => ({
				name: String(row.name ?? ""),
				models: Array.isArray(row.models) ? (row.models as string[]) : undefined,
				contextWindow: typeof row.contextWindow === "number" ? row.contextWindow : undefined,
			}))
		},
	}
}

export function createNodePrefixPort(host: RegistryHost): NodePrefixPort {
	return {
		async list() {
			return asRows(await host.nodes.list()).map((row) => ({
				id: String(row.id),
				prefix: typeof row.prefix === "string" ? row.prefix : undefined,
			}))
		},
	}
}
