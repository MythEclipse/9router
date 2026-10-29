import { getSessionContext } from "@9router/auth/dashboardPermissions"
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
import { NextResponse } from "next/server"
import { getCapabilitiesForModel } from "open-sse/providers/capabilities"
import { getDisabledModels } from "@/lib/disabledModelsDb"
import {
	collapseModelsByAdmittedId,
	filterModelsByAllowedModels,
} from "@/lib/usage/availableModels"
import { AI_MODELS } from "@/shared/constants/config"
import { CUSTOM_PLUGIN_KEYS } from "@/shared/constants/models"
import { FREE_PROVIDERS, getProviderAlias, resolveProviderId } from "@/shared/constants/providers"

export const dynamic = "force-dynamic"

/**
 * GET /api/usage/available-models - read-only catalog for the signing-in key.
 *
 * A key session holding only `viewUsage` cannot open /api/models or /api/combos, so this
 * endpoint rebuilds that catalog server side and narrows it to the session's allowedModels.
 * No writes.
 *
 * This handler assembles rows; the health rules live in `domain/available-models.ts`, and the
 * allowedModels filter and per-id collapse stay in `lib/usage/availableModels.ts` because
 * `availableModelsSelfCheck.mjs` loads that file directly.
 */
export async function GET() {
	try {
		const ctx = await getSessionContext()
		if (!ctx.session) {
			return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
		}

		const allowedModelsRaw = ctx.allowedModels || "*"
		const isApiKey = ctx.session.role === "apikey"

		const [modelAliases, disabled, customModels, combos, connections, studioModels, settings] =
			await Promise.all([
				import("@/models").then((m) => m.getModelAliases().catch(() => ({}))),
				getDisabledModels().catch(() => ({})),
				import("@/lib/localDb").then((m) => m.getCustomModels().catch(() => [])),
				import("@/lib/localDb").then((m) => m.getCombos().catch(() => [])),
				import("@/lib/localDb").then((m) => m.getProviderConnections().catch(() => [])),
				import("@9router/db/repos/modelEditorRepo").then((m) => m.getStudioModels().catch(() => [])),
				getSettings().catch(() => null),
			])

		const aliases = modelAliases || {}
		const entries = []

		for (const m of AI_MODELS || []) {
			if (!m?.provider || !m?.model) continue
			if (isModelDisabled(disabled, m.provider, m.model, getProviderAlias)) continue
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
		for (const m of customModels || []) {
			if (!m?.id || (m.kind || m.type || "llm") !== "llm") continue
			const fullModel = `${m.providerAlias}/${m.id}`
			if (seenFull.has(fullModel)) continue
			seenFull.add(fullModel)
			entries.push({
				name: m.name || m.id,
				model: m.id,
				provider: m.providerAlias,
				fullModel,
				routedModel: fullModel,
				alias: aliases[fullModel] || m.id,
				origin: "custom",
			})
		}

		for (const s of studioModels || []) {
			if (!s?.callName || !s?.provider || !s?.model) continue
			entries.push({
				name: s.displayName || s.callName,
				model: s.callName,
				provider: s.provider,
				fullModel: `${s.provider}/${s.callName}`,
				routedModel: s.callName,
				alias: s.callName,
				origin: "studio",
			})
		}

		const comboMembers = {}
		for (const combo of combos || []) {
			if (!combo?.name) continue
			comboMembers[combo.name] = Array.isArray(combo.models) ? combo.models : []
			entries.push({
				name: combo.name,
				model: combo.name,
				provider: "combo",
				fullModel: combo.name,
				routedModel: combo.name,
				alias: combo.name,
				origin: "combo",
			})
		}

		// Per-provider health from live connections: a provider with no active connection is
		// reported unavailable, one whose models are all locked reports cooldown. Combos roll up
		// the worst of their members.
		const index = indexProviders(connections || [], Date.now())
		const spellings = { aliasOf: getProviderAlias, idOf: resolveProviderId }
		const membersOf = (name) => comboMembers[name] || []
		const isCombo = (name) => name in comboMembers

		const comboDeps = {
			membersOf,
			isCombo,
			providerStatusOf: (provider) => {
				// Credential-free providers serve without a connection row.
				const id = resolveProviderId(provider)
				if (id && FREE_PROVIDERS[id]?.noAuth) return "ready"
				return providerStatus(provider, index, spellings)
			},
			modelLockStatusOf: (provider, bareModel) =>
				modelLockStatus(provider, bareModel, index, spellings),
		}

		// Context window per entry, from the same capability table the runtime uses. A model the
		// table does not know reports null rather than a guess - a wrong window is worse than an
		// absent one.
		const lookupContext = (provider, bareModel) => {
			try {
				return readContextWindow(getCapabilitiesForModel(provider, bareModel))
			} catch {
				return null
			}
		}

		const pluginSources = enabledPluginSources(settings?.customPlugins, CUSTOM_PLUGIN_KEYS)

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

			// A row is reachable as its full id, its bare model id, and - for a combo - the combo
			// name, so all of them are offered to the resolver.
			const pluginMarks = resolvePluginMarks(
				pluginMarkIds(entry, membersOf(entry.model)),
				pluginSources,
			)
			return { ...entry, status, contextWindow, pluginMarks }
		})

		// Deliberately not de-duplicated by bare model id: two rows behind different provider
		// connections are different call paths and both stay. Only the SAME call path collapses.
		const distinct = distinctCallPaths(withStatus)

		const models = filterModelsByAllowedModels(distinct, allowedModelsRaw)
		// One row per model, not one per connection. A model served by twenty connections is
		// still one model the key may call; collapsing is display-only - usage history and the
		// request gate stay per call path.
		const shown = collapseModelsByAdmittedId(models, allowedModelsRaw)
		shown.sort((a, b) => String(a.name).localeCompare(String(b.name)))

		return NextResponse.json(
			{
				models: shown,
				total: withStatus.length,
				callPaths: models.length,
				keyName: isApiKey ? ctx.session.keyName || "API Key" : null,
				tokenLimit: isApiKey ? ctx.session.tokenLimit || 0 : 0,
				allowedModels: allowedModelsRaw,
				generatedAt: new Date().toISOString(),
			},
			{ headers: { "Cache-Control": "no-store" } },
		)
	} catch (error) {
		console.error("[API] Failed to get available models:", error)
		return NextResponse.json({ error: "Failed to fetch available models" }, { status: 500 })
	}
}
