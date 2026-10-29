/**
 * The model-registry and catalogue hosts.
 *
 * `apps/api` owns the rules but cannot import this directory: these modules use
 * the `@/` alias and `open-sse/` paths, which that package does not resolve. So
 * the dashboard — the process that already bundles all of it — hands the modules
 * over as plain functions.
 *
 * Nothing here is a second implementation. Every entry is the same export the
 * routes used to call directly, which is the point: the rules moved, the calls
 * did not.
 */
import fs from "node:fs"
import { reconcileAllowedModels } from "@9router/db/repos/apiKeysRepo"
import {
	deleteStudioModel,
	getStudioModel,
	getStudioModels,
	setStudioModel,
} from "@9router/db/repos/modelEditorRepo"
import type {
	CatalogueHost,
	RegistryHost,
} from "9router-api/infrastructure/db/repositories/model-registry-repository"
import {
	aggregateComboCapabilities,
	getCapabilitiesForModel,
} from "open-sse/providers/capabilities"
import { CATALOG_FILE } from "open-sse/providers/catalogOverride"
import { resolveProviderAlias } from "open-sse/services/model"
import { pingModelByKind } from "@/app/api/models/test/ping"
import { fetchSuggestedModelsServer, onlyFree } from "@/app/api/providers/suggested-models/filters"
import { disableModels, enableModels, getDisabledModels } from "@/lib/disabledModelsDb"
import { getSyncState, syncModelCatalog } from "@/lib/modelCatalog/sync"
import {
	addCustomModel,
	createProviderNode,
	deleteCustomModel,
	deleteModelAlias,
	deleteProviderConnectionsByProvider,
	deleteProviderNode,
	getCombos,
	getCustomModels,
	getModelAliases,
	getProviderConnections,
	getProviderNodes,
	setModelAlias,
	updateProviderConnection,
	updateProviderNode,
} from "@/models"
import { AI_MODELS } from "@/shared/constants/config"
import { CAPACITY_META, isSttTransport } from "@/shared/constants/models"
import { ALIAS_TO_ID, FREE_PROVIDERS, getProviderAlias } from "@/shared/constants/providers"
import { generateId } from "@/shared/utils"
import { resolveModelDisplayName } from "@/shared/utils/modelDisplayName"
import { normalizeLogo } from "@/shared/utils/providerLogo"
import { assertPublicUrl } from "@/shared/utils/ssrfGuard"
import { describeStudioCycle, findStudioCycle } from "@/shared/utils/studioComboGuard"

/** Reads the on-disk catalogue summary; a missing file means "not synced yet". */
function readCatalogFile() {
	try {
		const parsed = JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8"))
		return {
			syncedAt: parsed.syncedAt,
			models: Object.keys(parsed.models || {}).length,
			providers: Object.keys(parsed.providers || {}).length,
			bytes: fs.statSync(CATALOG_FILE).size,
		}
	} catch {
		return null
	}
}

/** The stores the registry ports need. */
export const registryHost: RegistryHost = {
	aliases: {
		list: () => getModelAliases(),
		set: (alias, model) => setModelAlias(alias, model),
		remove: async (alias) => {
			await deleteModelAlias(alias)
		},
	},
	disabled: {
		list: () => getDisabledModels(),
		disable: (providerAlias, ids) => disableModels(providerAlias, ids),
		enable: (providerAlias, ids) => enableModels(providerAlias, ids),
	},
	customModels: {
		list: () => getCustomModels(),
		add: (fields) => addCustomModel(fields as never),
		remove: async (fields) => {
			await deleteCustomModel(fields)
		},
	},
	studioModels: {
		list: () => getStudioModels(),
		find: (callName) => getStudioModel(callName),
		save: (fields) => setStudioModel(fields as never),
		remove: async (callName) => {
			await deleteStudioModel(callName)
		},
	},
	reconcileAllowedModels: (change) => reconcileAllowedModels(change),
	connections: {
		list: (filter) => getProviderConnections(filter),
		update: (id, patch) => updateProviderConnection(id, patch as never),
	},
	nodes: {
		list: () => getProviderNodes(),
		create: (fields) => createProviderNode(fields as never),
		update: (id, patch) => updateProviderNode(id, patch as never),
		remove: async (id) => {
			await deleteProviderNode(id)
		},
		removeConnections: async (providerId) => {
			await deleteProviderConnectionsByProvider(providerId)
		},
	},
	combos: { list: () => getCombos() },
}

/** The capability tables, live catalogue and probe. */
export const catalogueHost: CatalogueHost = {
	curatedModels: () => AI_MODELS,
	async fetchLiveFree() {
		const free = Object.entries(FREE_PROVIDERS).filter(
			([, provider]) => provider.noAuth && !provider.hidden && provider.modelsFetcher,
		)
		const fetched = await Promise.all(
			free.map(async ([id, provider]) => ({
				alias: provider.alias || id,
				models: onlyFree(await fetchSuggestedModelsServer(provider.modelsFetcher)),
			})),
		)
		return fetched.flatMap(({ alias, models }) =>
			models.map((model) => ({
				alias,
				model: model.id,
				name: model.name,
				contextLength: model.contextLength,
			})),
		)
	},
	capabilities: (provider, model) => getCapabilitiesForModel(provider, model),
	providerIdOf: (alias) => ALIAS_TO_ID[alias] || getProviderAlias(alias) || alias,
	aggregateCombo: (members, byName, contextWindow) =>
		aggregateComboCapabilities(members, byName, null, 0, contextWindow),
	displayName: (model, fallback) => resolveModelDisplayName(model, fallback),
	generateId: () => generateId(),
	normalizeLogo: (value) => normalizeLogo(value),
	async rejectUrl(raw, local) {
		if (local) return null
		try {
			assertPublicUrl(raw)
			return null
		} catch {
			return "URL not allowed"
		}
	},
	capabilityKeys: () => Object.keys(CAPACITY_META),
	// The picker's options; `isSttTransport` stays the authority on what is accepted.
	sttTransports: () => Object.keys(CAPACITY_META).filter((key) => isSttTransport(key)),
	readCatalogFile: async () => readCatalogFile(),
	syncState: () => getSyncState() as unknown as Record<string, unknown>,
	runSync: () => syncModelCatalog(),
	ping: (model, kind) => pingModelByKind(model, kind),
}

/** The STT transports the gateway can dial, from the shared constants. */
export function knownSttTransport(value: string): boolean {
	return isSttTransport(value)
}

/** The studio cycle guard, which walks the combo graph beside it. */
export function studioCycleRefusal(input: {
	callName: string
	comboName: string
	combosByName: Map<string, string[]>
	studioTargets: Map<string, string>
	extraSelfNames: string[]
}): string | null {
	const cycle = findStudioCycle(input)
	return cycle ? describeStudioCycle(cycle) : null
}

/** Probes a base URL with a key before a node is saved. */
export async function probeBaseUrl(input: {
	baseUrl: string
	apiKey: string
	type: string
	modelId?: string
}): Promise<Record<string, unknown>> {
	const { validateBaseUrl } = await import("@/app/api/provider-nodes/validate/probe")
	return validateBaseUrl(input)
}

export { resolveProviderAlias }
