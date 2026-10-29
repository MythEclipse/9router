/**
 * The available-model catalogue, built for the caller's key.
 *
 * Extracted from `api/usage/available-models/route.ts` so the oRPC procedure and the REST route
 * answer from one implementation. The *rules* — health rolling, plugin marks, call-path collapse
 * — stay in `domain/available-models.ts` and `lib/usage/availableModels.ts`; this file is the
 * assembly, which is the part that has to read the model tables, the connection rows and the
 * plugin settings together.
 *
 * Two behaviours here are load-bearing and each had its own comment before:
 *
 * - **Rows are not de-duplicated by bare model id.** Two rows behind different connections are
 *   different call paths and both stay; only the *same* call path collapses. Usage history and
 *   the request gate are per call path, so merging them early would hide a working path behind
 *   a cooling one.
 * - **A model the capability table does not know reports a null context window.** A guessed
 *   window is worse than an absent one: the picker would warn about a model that is fine.
 */
import { getStudioModels } from "@9router/db/repos/modelEditorRepo"
import { getSettings } from "@9router/db/repos/settingsRepo"
import {
	comboContextWindow,
	comboStatus,
	distinctCallPaths,
	enabledPluginSources,
	indexProviders,
	isModelDisabled,
	modelLockStatus,
	pluginMarkIds,
	providerStatus,
	readContextWindow,
	resolvePluginMarks,
	worstModelStatus,
} from "9router-api/domain/available-models"
import { getCapabilitiesForModel } from "open-sse/providers/capabilities"
import { getDisabledModels } from "@/lib/disabledModelsDb"
import { getCombos, getCustomModels, getProviderConnections } from "@/lib/localDb"
import {
	collapseModelsByAdmittedId,
	filterModelsByAllowedModels,
} from "@/lib/usage/availableModels"
import { AI_MODELS } from "@/shared/constants/config"
import { CUSTOM_PLUGIN_KEYS } from "@/shared/constants/models"
import { FREE_PROVIDERS, getProviderAlias, resolveProviderId } from "@/shared/constants/providers"

/** What the page may show for the signing-in key. */
export interface AvailableModelsScope {
	readonly allowedModels: string
	readonly isApiKey: boolean
	/** The key's own name and cap, for the header line; absent for a password session. */
	readonly keyName?: string | null
	readonly tokenLimit?: number
}

/** One catalogue entry before it is given a status. */
interface CatalogueEntry {
	name: string
	model: string
	provider: string
	fullModel: string
	routedModel: string
	alias: string
	origin: "provider" | "custom" | "studio" | "combo"
}

type Row = Record<string, unknown>

/** Every table the assembly reads, fetched in one round trip each. */
async function readCatalogueSources() {
	const [modelAliases, disabled, customModels, combos, connections, studioModels, settings] =
		await Promise.all([
			import("@/models").then((m) => m.getModelAliases().catch(() => ({}))).catch(() => ({})),
			getDisabledModels().catch(() => ({})),
			getCustomModels().catch(() => []),
			getCombos().catch(() => []),
			getProviderConnections().catch(() => []),
			getStudioModels().catch(() => []),
			getSettings().catch(() => null),
		])
	return {
		modelAliases: (modelAliases || {}) as Record<string, string>,
		disabled: disabled as Row,
		customModels: customModels as Row[],
		combos: combos as Row[],
		connections: connections as Row[],
		studioModels: studioModels as Row[],
		settings: settings as Row | null,
	}
}

/** Provider, custom, studio and combo rows, in that order, before any status is applied. */
function catalogueEntries(sources: Awaited<ReturnType<typeof readCatalogueSources>>): {
	entries: CatalogueEntry[]
	comboMembers: Record<string, string[]>
} {
	const aliases = sources.modelAliases
	const entries: CatalogueEntry[] = []

	for (const m of AI_MODELS || []) {
		if (!m?.provider || !m?.model) continue
		if (isModelDisabled(sources.disabled, m.provider, m.model, getProviderAlias)) continue
		const fullModel = `${m.provider}/${m.model}`
		const providerAlias = getProviderAlias(m.provider) || m.provider
		entries.push({
			name: m.name || m.model,
			model: m.model,
			provider: providerAlias,
			fullModel,
			routedModel: `${providerAlias}/${m.model}`,
			alias: aliases[fullModel] || m.model,
			origin: "provider",
		})
	}

	const seenFull = new Set(entries.map((e) => e.fullModel))
	for (const m of sources.customModels || []) {
		if (!m?.id || (m.kind || m.type || "llm") !== "llm") continue
		const fullModel = `${m.providerAlias}/${m.id}`
		if (seenFull.has(fullModel)) continue
		seenFull.add(fullModel)
		entries.push({
			name: (m.name as string) || (m.id as string),
			model: m.id as string,
			provider: m.providerAlias as string,
			fullModel,
			routedModel: fullModel,
			alias: aliases[fullModel] || (m.id as string),
			origin: "custom",
		})
	}

	for (const s of sources.studioModels || []) {
		if (!s?.callName || !s?.provider || !s?.model) continue
		entries.push({
			name: (s.displayName as string) || (s.callName as string),
			model: s.callName as string,
			provider: s.provider as string,
			fullModel: `${s.provider}/${s.callName}`,
			routedModel: s.callName as string,
			alias: s.callName as string,
			origin: "studio",
		})
	}

	const comboMembers: Record<string, string[]> = {}
	for (const combo of sources.combos || []) {
		if (!combo?.name) continue
		const name = combo.name as string
		comboMembers[name] = Array.isArray(combo.models) ? (combo.models as string[]) : []
		entries.push({
			name,
			model: name,
			provider: "combo",
			fullModel: name,
			routedModel: name,
			alias: name,
			origin: "combo",
		})
	}

	return { entries, comboMembers }
}

export async function buildAvailableModels(scope: AvailableModelsScope) {
	const sources = await readCatalogueSources()
	const { entries, comboMembers } = catalogueEntries(sources)

	// Per-provider health from live connections: a provider with no active connection is
	// unavailable, one whose models are all locked reports cooldown. Combos roll up the worst
	// of their members.
	const index = indexProviders(sources.connections || [], Date.now())
	const spellings = { aliasOf: getProviderAlias, idOf: resolveProviderId }
	const membersOf = (name: string) => comboMembers[name] || []
	const isCombo = (name: string) => name in comboMembers

	const comboDeps = {
		membersOf,
		isCombo,
		providerStatusOf: (provider: string) => {
			// Credential-free providers serve without a connection row.
			const id = resolveProviderId(provider)
			if (id && FREE_PROVIDERS[id]?.noAuth) return "ready"
			return providerStatus(provider, index, spellings)
		},
		modelLockStatusOf: (provider: string, bareModel: string) =>
			modelLockStatus(provider, bareModel, index, spellings),
	}

	const lookupContext = (provider: string, bareModel: string) => {
		try {
			return readContextWindow(getCapabilitiesForModel(provider, bareModel))
		} catch {
			return null
		}
	}

	const pluginSources = enabledPluginSources(
		((sources.settings as Row | null)?.customPlugins ?? {}) as Readonly<
			Record<string, { readonly enabled?: unknown; readonly models?: unknown }>
		>,
		CUSTOM_PLUGIN_KEYS,
	)

	const withStatus = entries.map((entry) => {
		const status =
			entry.origin === "combo"
				? comboStatus(entry.model, comboDeps)
				: worstModelStatus([
						comboDeps.providerStatusOf(entry.provider),
						comboDeps.modelLockStatusOf(entry.provider, entry.model),
					])

		const contextWindow =
			entry.origin === "combo"
				? comboContextWindow(entry.model, membersOf, isCombo, lookupContext)
				: lookupContext(entry.provider, entry.model)

		// A row is reachable as its full id, its bare model id, and — for a combo — the combo
		// name, so all of them are offered to the resolver.
		const pluginMarks = resolvePluginMarks(
			pluginMarkIds(entry, membersOf(entry.model)),
			pluginSources,
		)
		return { ...entry, status, contextWindow, pluginMarks }
	})

	// Deliberately not de-duplicated by bare model id; see the file header.
	const distinct = distinctCallPaths(withStatus)
	const models = filterModelsByAllowedModels(distinct, scope.allowedModels)
	// One row per model, not one per connection: collapsing is display-only.
	const shown = collapseModelsByAdmittedId(models, scope.allowedModels)
	shown.sort((a, b) => String(a.name).localeCompare(String(b.name)))

	return {
		models: shown,
		total: withStatus.length,
		callPaths: models.length,
		keyName: scope.isApiKey ? scope.keyName || "API Key" : null,
		tokenLimit: scope.isApiKey ? scope.tokenLimit || 0 : 0,
		allowedModels: scope.allowedModels,
		generatedAt: new Date().toISOString(),
	}
}
