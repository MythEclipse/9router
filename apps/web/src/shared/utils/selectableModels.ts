/**
 * "The models this user can currently route to", resolved the way the picker does.
 *
 * Callers that need a flat list of routing values — the CLI tools' "Add All Active
 * Models" button is the first — used to walk the static provider registry over
 * connection rows. That misses everything the picker knows from runtime data:
 * no-auth free providers (OpenCode Free owns no connection row), the user's own
 * aliases, models registered through /api/models/custom, per-account live
 * catalogues, and the disabled/enabled filters. The result was a button that
 * added a different set from the one the picker offered right next to it.
 *
 * The rules here mirror ModelSelectModal's memo. They are duplicated rather than
 * shared because that memo is interleaved with its React state (live fetches,
 * studio targets, search); lifting it out is a refactor of the picker, not of a
 * button. Keep the two in step when either changes.
 */
import { getModelKind, getModelsByProviderId } from "@/shared/constants/models"
import {
	AI_PROVIDERS,
	APIKEY_PROVIDERS,
	FREE_PROVIDERS,
	FREE_TIER_PROVIDERS,
	getProviderAlias,
	isAnthropicCompatibleProvider,
	isOpenAICompatibleProvider,
	OAUTH_PROVIDERS,
} from "@/shared/constants/providers"
import { getDeactivatedProviderIds } from "@/shared/utils/connectionStatus"

/** Provider order: OAuth first, then Free Tier, then API Key (as on the providers page). */
export const PROVIDER_ORDER = [
	...Object.keys(OAUTH_PROVIDERS),
	...Object.keys(FREE_PROVIDERS),
	...Object.keys(FREE_TIER_PROVIDERS),
	...Object.keys(APIKEY_PROVIDERS),
]

/**
 * Providers that need no auth — always selectable, and they never own a connection
 * row, so any caller that only walks connections misses them entirely.
 *
 * Hidden entries stay out even though they keep `noAuth`: upstream channel is gone,
 * so the picker does not offer them. Mirrors the picker's filter.
 */
export const NO_AUTH_PROVIDER_IDS = Object.keys(FREE_PROVIDERS).filter(
	(id) => FREE_PROVIDERS[id].noAuth && !FREE_PROVIDERS[id].hidden,
)

/** Providers with a per-account live catalogue via /api/providers/[id]/models. */
export const LIVE_CATALOG_PROVIDERS = ["cursor", "cline", "clinepass", "zed", "nous"]

export const ALL_PROVIDERS = {
	...OAUTH_PROVIDERS,
	...FREE_PROVIDERS,
	...FREE_TIER_PROVIDERS,
	...APIKEY_PROVIDERS,
}

const asArray = <T>(value: readonly T[] | null | undefined): T[] =>
	Array.isArray(value) ? [...value] : []

interface ModelEntry {
	readonly id: string
	readonly name?: string
	readonly value: string
	readonly kind?: string
	readonly isCustom?: boolean
	readonly isPlaceholder?: boolean
}

interface GroupEntry {
	name: string
	alias: string
	color?: string
	models: ModelEntry[]
	isCustom?: boolean
	hasModels?: boolean
}

/** Kinds where the provider *is* the model — no per-model selection. */
const PROVIDER_AS_MODEL_KINDS = new Set(["webSearch", "webFetch"])
/** Kinds that map straight onto `model.type`. */
const TYPED_KINDS = new Set(["image", "tts", "stt", "embedding", "imageToText", "systemone"])
/** Kinds where a provider without hardcoded models can still be picked as the model. */
const ALLOW_PROVIDER_FALLBACK_KINDS = new Set(["tts", "image", "webFetch"])

export interface BuildModelGroupsInput {
	/** Active connections, already filtered by kind. */
	readonly connections?: readonly Record<string, any>[]
	/** Every connection, to resolve custom-provider display names and deactivation. */
	readonly allConnections?: readonly Record<string, any>[]
	/** e.g. "image" | "webSearch"; null/undefined is the LLM selector. */
	readonly kindFilter?: string | null
	/** aliasName -> "providerAlias/modelId" */
	readonly modelAliases?: Record<string, string>
	/** Compatible-provider nodes. */
	readonly providerNodes?: readonly Record<string, any>[]
	/** Rows from /api/models/custom. */
	readonly customModels?: readonly Record<string, any>[]
	/** alias -> disabled model ids. */
	readonly disabledModels?: Record<string, readonly string[]>
	/** { cursor: [], cline: [], ... } account-scoped catalogues. */
	readonly liveModels?: Record<string, readonly Record<string, any>[]>
	readonly providers?: Record<string, any>
}

/**
 * Grouped, ordered, filtered models for one picker kind.
 *
 * Inputs are tolerated as empty or missing: a caller with no connections still gets
 * the no-auth providers, which is the whole point of sharing these rules.
 */
export function buildModelGroups(input: BuildModelGroupsInput = {}): Record<string, GroupEntry> {
	const filteredActiveProviders = asArray(input.connections)
	const effectiveConnections = asArray(input.allConnections ?? input.connections)
	const providerNodesSafe = asArray(input.providerNodes)
	const customModelsSafe = asArray(input.customModels)
	const modelAliasesSafe = input.modelAliases || {}
	const disabledModelsSafe = input.disabledModels || {}
	const allProviders = input.providers || ALL_PROVIDERS
	const kindFilter = input.kindFilter ?? null

	// Paused providers (every connection of theirs is inactive) drop out; providers with
	// no connection row at all stay, e.g. keyless local endpoints.
	const deactivatedProviderIds = getDeactivatedProviderIds(effectiveConnections)

	const live = input.liveModels || {}
	const liveFor = (providerId: string): Record<string, any>[] => asArray(live[providerId])

	const groups: Record<string, GroupEntry> = {}

	const filterByKind = (models: ModelEntry[]): ModelEntry[] => {
		// No kindFilter means the LLM selector. Custom models stay visible: their typed
		// capability (imageToText, say) does not stop them being valid chat targets.
		if (!kindFilter)
			return models.filter(
				(m) => m.isPlaceholder || m.isCustom || !getModelKind(m) || getModelKind(m) === "llm",
			)
		if (!TYPED_KINDS.has(kindFilter)) return models
		return models.filter((m) => m.isPlaceholder || getModelKind(m) === kindFilter)
	}

	const activeConnectionIds = filteredActiveProviders.map((p) => p.provider)

	const noAuthIds = (
		kindFilter
			? NO_AUTH_PROVIDER_IDS.filter((id) =>
					(AI_PROVIDERS[id]?.serviceKinds || ["llm"]).includes(kindFilter),
				)
			: NO_AUTH_PROVIDER_IDS
	).filter((id) => !deactivatedProviderIds.has(id))

	// A compatible node with user-added models is selectable even without a stored key:
	// local/self-hosted endpoints do not always have one, so gating on connections hides
	// models the user already added. These nodes are LLM-only, so only when no kind filter.
	const existingNodeIds = new Set(
		providerNodesSafe.map((node) => node?.id).filter((id): id is string => Boolean(id)),
	)
	const compatibleNodeIds = kindFilter
		? []
		: customModelsSafe
				.map((m) => m.providerAlias as string)
				.filter(
					(alias) =>
						(isOpenAICompatibleProvider(alias) || isAnthropicCompatibleProvider(alias)) &&
						existingNodeIds.has(alias) &&
						!deactivatedProviderIds.has(alias),
				)

	const providerIdsToShow = new Set(
		[...activeConnectionIds, ...noAuthIds, ...compatibleNodeIds].filter(
			(id) => !deactivatedProviderIds.has(id),
		),
	)

	const sortedProviderIds = [...providerIdsToShow].sort((a, b) => {
		const indexA = PROVIDER_ORDER.indexOf(a)
		const indexB = PROVIDER_ORDER.indexOf(b)
		return (indexA === -1 ? 999 : indexA) - (indexB === -1 ? 999 : indexB)
	})

	for (const providerId of sortedProviderIds) {
		const alias = getProviderAlias(providerId)
		const providerInfo = allProviders[providerId] || { name: providerId, color: "#666" }
		const isCustomProvider =
			isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId)

		// Provider-as-model kinds: one entry whose value is the provider id itself.
		if (kindFilter && PROVIDER_AS_MODEL_KINDS.has(kindFilter)) {
			groups[providerId] = {
				name: providerInfo.name,
				alias,
				color: providerInfo.color,
				models: [{ id: providerId, name: providerInfo.name, value: providerId }],
			}
			continue
		}

		if (providerInfo.passthroughModels) {
			const aliasModels: ModelEntry[] = Object.entries(modelAliasesSafe)
				.filter(([, fullModel]) => fullModel.startsWith(`${alias}/`))
				.map(([aliasName, fullModel]) => ({
					id: fullModel.replace(`${alias}/`, ""),
					name: aliasName,
					value: fullModel,
				}))
			const customRegisteredModels: ModelEntry[] = customModelsSafe
				.filter((m) => m.providerAlias === alias)
				.map((m) => ({
					id: m.id,
					name: m.name || m.id,
					value: `${alias}/${m.id}`,
					kind: getModelKind(m),
					isCustom: true,
				}))

			let combined: ModelEntry[] = aliasModels
			if (kindFilter && TYPED_KINDS.has(kindFilter)) {
				// Aliases rarely carry type information, so typed kinds come from the registry.
				const registeredTyped = customRegisteredModels.filter((m) => getModelKind(m) === kindFilter)
				combined = [
					...registeredTyped,
					...getModelsByProviderId(providerId)
						.filter((m) => getModelKind(m) === kindFilter)
						.map((m) => ({ id: m.id, name: m.name, value: `${alias}/${m.id}`, kind: getModelKind(m) }))
						.filter((m) => !registeredTyped.some((registered) => registered.value === m.value)),
				]
				if (combined.length === 0 && ALLOW_PROVIDER_FALLBACK_KINDS.has(kindFilter)) {
					const supports = (providerInfo.serviceKinds || ["llm"]).includes(kindFilter)
					if (supports) combined = [{ id: providerId, name: providerInfo.name, value: alias }]
				}
			} else {
				// LLM/null kind: merge user-added models over the static registry.
				const registeredLlms = customRegisteredModels.filter(
					(m) => !getModelKind(m) || getModelKind(m) === "llm",
				)
				const seen = new Set([...aliasModels, ...registeredLlms].map((m) => m.value))
				const hardcoded = getModelsByProviderId(providerId)
					.filter((m) => !getModelKind(m) || getModelKind(m) === "llm")
					.map((m) => ({ id: m.id, name: m.name, value: `${alias}/${m.id}`, kind: getModelKind(m) }))
					.filter((m) => !seen.has(m.value))
				combined = [
					...registeredLlms,
					...aliasModels.filter(
						(m) => !registeredLlms.some((registered) => registered.value === m.value),
					),
					...hardcoded,
				]
			}

			if (combined.length > 0) {
				const matchedNode = providerNodesSafe.find((node) => node.id === providerId)
				groups[providerId] = {
					name: matchedNode?.name || providerInfo.name,
					alias,
					color: providerInfo.color,
					models: combined,
				}
			}
			continue
		}

		if (isCustomProvider) {
			// Compatible providers are LLM-only — skip the typed media kinds.
			if (kindFilter && TYPED_KINDS.has(kindFilter)) continue
			const connection =
				filteredActiveProviders.find((p) => p.provider === providerId) ||
				effectiveConnections.find((p) => p.provider === providerId)
			const matchedNode = providerNodesSafe.find((node) => node.id === providerId)
			const displayName = matchedNode?.name || connection?.name || providerInfo.name
			const nodePrefix = connection?.providerSpecificData?.prefix || matchedNode?.prefix || providerId

			// Aliases are keyed by the raw providerId ("openai-compatible-chat-<uuid>/glm-4.7"),
			// so filter by providerId but emit under the display prefix.
			const nodeModels: ModelEntry[] = Object.entries(modelAliasesSafe)
				.filter(([, fullModel]) => fullModel.startsWith(`${providerId}/`))
				.map(([aliasName, fullModel]) => ({
					id: fullModel.replace(`${providerId}/`, ""),
					name: aliasName,
					value: `${nodePrefix}/${fullModel.replace(`${providerId}/`, "")}`,
				}))
			const registeredCustom: ModelEntry[] = customModelsSafe
				.filter((m) => m.providerAlias === providerId)
				.map((m) => ({
					id: m.id,
					name: m.name || m.id,
					value: `${nodePrefix}/${m.id}`,
					isCustom: true,
				}))
			const seen = new Set(nodeModels.map((m) => m.value))
			const mergedModels = [...nodeModels, ...registeredCustom.filter((m) => !seen.has(m.value))]

			// A connected compatible provider with no aliases still shows, as a placeholder,
			// so the operator can see it is available.
			const modelsToShow =
				mergedModels.length > 0
					? mergedModels
					: [
							{
								id: `__placeholder__${providerId}`,
								name: `${nodePrefix}/model-id`,
								value: `${nodePrefix}/model-id`,
								isPlaceholder: true,
							},
						]

			groups[providerId] = {
				name: displayName,
				alias: nodePrefix,
				color: providerInfo.color,
				models: modelsToShow,
				isCustom: true,
				hasModels: mergedModels.length > 0,
			}
			continue
		}

		const liveModels = liveFor(providerId)
		const hardcodedModels = liveModels.length > 0 ? liveModels : getModelsByProviderId(providerId)
		const hardcodedIds = new Set(hardcodedModels.map((m) => m.id))

		// With no hardcoded models (openrouter, say) every alias is a model. Otherwise only
		// aliases whose name equals the model id ("Add Model" button pattern).
		const hasHardcoded = hardcodedModels.length > 0
		const customAliasModels: ModelEntry[] = Object.entries(modelAliasesSafe)
			.filter(
				([aliasName, fullModel]) =>
					fullModel.startsWith(`${alias}/`) &&
					(hasHardcoded ? aliasName === fullModel.replace(`${alias}/`, "") : true) &&
					!hardcodedIds.has(fullModel.replace(`${alias}/`, "")),
			)
			.map(([aliasName, fullModel]) => ({
				id: fullModel.replace(`${alias}/`, ""),
				name: aliasName,
				value: fullModel,
				isCustom: true,
			}))

		const customAliasIds = new Set(customAliasModels.map((m) => m.id))
		const customRegisteredModels: ModelEntry[] = customModelsSafe
			.filter((m) => m.providerAlias === alias && !hardcodedIds.has(m.id) && !customAliasIds.has(m.id))
			.map((m) => ({ id: m.id, name: m.name || m.id, value: `${alias}/${m.id}`, isCustom: true }))

		const merged: ModelEntry[] = [
			...hardcodedModels.map((m) => ({
				id: m.id,
				name: m.name,
				value: `${alias}/${m.id}`,
				kind: getModelKind(m),
			})),
			...customAliasModels,
			...customRegisteredModels,
		]

		// Dedupe by value: an alias may equal a hardcoded id, which would collide as a key.
		const seen = new Set<string>()
		let allModels = filterByKind(
			merged.filter((m) => {
				if (seen.has(m.value)) return false
				seen.add(m.value)
				return true
			}),
		)

		if (allModels.length === 0 && kindFilter && ALLOW_PROVIDER_FALLBACK_KINDS.has(kindFilter)) {
			const supports = (providerInfo.serviceKinds || ["llm"]).includes(kindFilter)
			if (supports) allModels = [{ id: providerId, name: providerInfo.name, value: alias }]
		}

		if (allModels.length > 0) {
			groups[providerId] = {
				name: providerInfo.name,
				alias,
				color: providerInfo.color,
				models: allModels,
			}
		}
	}

	// Disabled models are keyed by storage alias OR providerId; honour both.
	for (const [providerId, group] of Object.entries(groups)) {
		const aliasKey = getProviderAlias(providerId)
		const disabledIds = new Set([
			...(disabledModelsSafe[aliasKey] || []),
			...(disabledModelsSafe[providerId] || []),
		])
		if (disabledIds.size === 0) continue
		group.models = group.models.filter((m) => !disabledIds.has(m.id))
		if (group.models.length === 0) delete groups[providerId]
	}

	// An explicit enabledModels list on any active connection narrows the whole provider.
	for (const [providerId, group] of Object.entries(groups)) {
		const providerConns = filteredActiveProviders.filter((p) => p.provider === providerId)
		const explicitEnabled: string[] = []
		for (const conn of providerConns) {
			if (
				Array.isArray(conn.providerSpecificData?.enabledModels) &&
				conn.providerSpecificData.enabledModels.length > 0
			)
				explicitEnabled.push(...conn.providerSpecificData.enabledModels)
		}
		if (explicitEnabled.length === 0) continue
		const enabledSet = new Set(explicitEnabled)
		const alias = group.alias || getProviderAlias(providerId) || providerId
		group.models = group.models.filter(
			(m) =>
				enabledSet.has(m.id) ||
				enabledSet.has(m.value) ||
				enabledSet.has(`${alias}/${m.id}`) ||
				(m.value && enabledSet.has(m.value.replace(`${alias}/`, ""))),
		)
		if (group.models.length === 0) delete groups[providerId]
	}

	return groups
}

/**
 * The routing values in a group set, deduped, in order.
 *
 * This is what a caller hands to a tool's model list ("alias/model-id"). The picker
 * reads the groups directly instead, because it needs the names and kinds too.
 */
export function collectModelValues(
	groups: Record<string, GroupEntry> | null | undefined,
): string[] {
	const values: string[] = []
	const seen = new Set<string>()
	for (const group of Object.values(groups || {})) {
		for (const model of asArray(group?.models)) {
			const value = typeof model === "string" ? model : model?.value
			if (!value || seen.has(value)) continue
			seen.add(value)
			values.push(value)
		}
	}
	return values
}
