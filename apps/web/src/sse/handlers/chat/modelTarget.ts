import { augmentModelsWithCapacityAdapter } from "open-sse/services/capacityAdapter"
import { filterAdapterModels } from "../../services/keyAccess.ts"
import { getComboModels, getModelInfo } from "../../services/model.ts"

/** The single model a request routes to, once overrides have been applied. */
export interface SingleModelTarget {
	kind: "single"
	provider: string
	model: string
}

/** The request names something that resolves to a combo instead of one model. */
export interface ComboModelTarget {
	kind: "combo"
	comboEntryName: string
	comboModels: string[]
}

/** Neither a routable model nor a combo: the caller's model string is wrong. */
export interface UnresolvableModelTarget {
	kind: "unresolvable"
}

export type ModelTarget = SingleModelTarget | ComboModelTarget | UnresolvableModelTarget

/**
 * Decide whether a model string routes to one model or fans out over a combo.
 *
 * A studio name that points at a combo is the reason this is not just
 * `getModelInfo`: `getModelInfo` answers such a studio with the combo name in
 * `model`, so that name is the entry to look combos up by.
 */
export async function resolveModelTarget(modelStr: string): Promise<ModelTarget> {
	const modelInfo = await getModelInfo(modelStr)

	// If provider is null, this might be a combo name - check and handle.
	// A studio name may also resolve here: getModelInfo answers a studio that
	// points at a combo with the combo name in `model`, so use it as the entry.
	if (!modelInfo.provider) {
		const comboEntryName =
			!modelStr.includes("/") && modelInfo.model && modelInfo.model !== modelStr
				? modelInfo.model
				: modelStr
		const comboModels = await getComboModels(comboEntryName)
		if (comboModels) return { kind: "combo", comboEntryName, comboModels }
		return { kind: "unresolvable" }
	}

	return { kind: "single", provider: modelInfo.provider, model: modelInfo.model }
}

/**
 * The members a combo actually runs: capacity-adapter duplicates added for the
 * capabilities this request needs, gated by what the caller's key may call.
 */
export async function resolveComboMembers({
	comboModels,
	requiredCapabilities,
	settings,
	keyAccess,
}: {
	comboModels: string[]
	requiredCapabilities: Set<unknown>
	settings: any
	keyAccess: any
}) {
	// Nested combo access remains constrained by this request's API key.
	const augmentedModels: string[] = await filterAdapterModels(
		keyAccess,
		augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, settings),
		comboModels,
	)
	const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m))
	return { augmentedModels, adapterAdded }
}
