/**
 * Derivations the provider detail page computes on every render.
 *
 * They were inline IIFEs inside a 2,000-line component, which made the three rules
 * that actually matter impossible to assert: which levels the picker offers, which
 * model a thinking suffix applies to, and what the bulk-proxy summary says.
 */

type ThinkingLevelsOf = (providerId: string, modelId: string) => string[] | null | undefined

/**
 * The `(level)` suffix to append to a model id, or null when there is none.
 *
 * `auto` means "let the router choose", so it never produces a suffix even though
 * it appears in the picker. A level the model does not support is also dropped
 * rather than written into the id, where the upstream would reject it.
 */
export function resolveThinkingSuffix(
	modelId: string,
	thinkingMode: string | null | undefined,
	providerId: string,
	getThinkingLevels: ThinkingLevelsOf,
): string | null {
	if (!thinkingMode || thinkingMode === "auto") return null
	const levels = getThinkingLevels(providerId, modelId)
	return levels && levels.includes(thinkingMode) ? thinkingMode : null
}

export interface CustomModelEntry {
	id: string
	providerAlias?: string
	kind?: string
	type?: string
}

export interface ThinkingLevelSource {
	/** The catalog models for this provider. */
	models: Array<{ id: string }>
	/** Models from the free-tier catalog, unioned in. */
	freeModels?: Array<{ id: string }>
	/** Every custom model across providers; filtered here by alias and kind. */
	customModels?: CustomModelEntry[]
	/** The alias custom models must carry to belong to this provider. */
	storageAlias: string
}

/**
 * The union of thinking levels across a provider's reasoning models, prefixed with
 * `auto`, or null when no model reasons at all (so the picker is hidden).
 *
 * Custom models are included — a hand-added `gpt-5.6-sol` should offer `max` — but
 * only the ones that belong to this provider and are LLMs. `none` is excluded
 * because it is the absence of a level, not a choice.
 */
export function providerThinkingLevels(
	providerId: string,
	source: ThinkingLevelSource,
	getThinkingLevels: ThinkingLevelsOf,
): string[] | null {
	const set = new Set<string>()
	const seen = new Set<string>()

	const addLevels = (modelId: string | undefined) => {
		if (!modelId || seen.has(modelId)) return
		seen.add(modelId)
		const levels = getThinkingLevels(providerId, modelId)
		if (levels) {
			for (const level of levels) {
				if (level !== "none") set.add(level)
			}
		}
	}

	for (const model of source.models || []) addLevels(model.id)
	for (const model of source.freeModels || []) addLevels(model.id)
	for (const entry of source.customModels || []) {
		if (entry.providerAlias !== source.storageAlias) continue
		if ((entry.kind || entry.type || "llm") !== "llm") continue
		addLevels(entry.id)
	}

	return set.size ? ["auto", ...set] : null
}

/** The shared pool id used to mean "no pool bound". */
export const NO_POOL = "__none__"

/**
 * Describe the proxy bindings across the selected connections.
 *
 * Returns "" for an empty selection so the caller can hide the line entirely.
 * When every selected connection agrees, the message names the one pool; otherwise
 * it says they are mixed, which is what makes the bulk edit destructive-looking.
 */
export function summarizeSelectedProxies(
	selectedConnections: Array<{ providerSpecificData?: { proxyPoolId?: string } }>,
	proxyPools: Array<{ id: string; name?: string }>,
): string {
	if (!selectedConnections.length) return ""

	const poolIds = new Set(
		selectedConnections.map((conn) => conn.providerSpecificData?.proxyPoolId || NO_POOL),
	)
	if (poolIds.size !== 1) return "Selected connections have mixed proxy bindings"

	const onlyId = [...poolIds][0]
	if (onlyId === NO_POOL) return "All selected currently unbound"
	const pool = proxyPools.find((p) => p.id === onlyId)
	return `All selected currently bound to ${pool?.name || onlyId}`
}

/**
 * The pool the bulk-proxy modal should start on: the shared binding when the
 * selection is uniform, otherwise "unbound".
 */
export function initialBulkProxyPoolId(
	selectedConnections: Array<{ providerSpecificData?: { proxyPoolId?: string } }>,
): string {
	const uniquePoolIds = [
		...new Set(selectedConnections.map((conn) => conn.providerSpecificData?.proxyPoolId || NO_POOL)),
	]
	return uniquePoolIds.length === 1 ? uniquePoolIds[0] : NO_POOL
}
