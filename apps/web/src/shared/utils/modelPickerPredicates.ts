/**
 * Model picker predicates.
 *
 * The scope check is not implemented here: the picker must admit exactly what the
 * request gate admits, so it calls the same `matchesAllowedModels` the server uses.
 * A copy would drift, and the failure is silent in one direction — a scoped session
 * offered a model it is then refused for.
 */
import { matchesAllowedModels } from "@/lib/db/repos/allowedModels"

/**
 * Whether a model is inside a scope, checking every name a caller may hold for it.
 *
 * A model is known by its id and by a display value (`providerAlias/id`, `callName`,
 * …); a scope may name either, so a hit on any candidate counts.
 */
export function matchesModelScope(
	patterns: string[] | null | undefined,
	...candidates: Array<string | null | undefined>
): boolean {
	if (!patterns || patterns.length === 0) return true
	return candidates
		.filter((c): c is string => Boolean(c))
		.some((candidate) => matchesAllowedModels(patterns, candidate))
}

/**
 * Whether a custom model's `providerAlias` points at a deleted compatible node.
 *
 * Only aliases that look like generated compat node ids can be orphans: `humanizeCompatId`
 * returns "" for anything else, which is how a plain provider name is excluded. An alias a
 * live node still claims is not an orphan, so its group stays visible.
 */
export function isOrphanCompatAlias(
	alias: unknown,
	providerNodes: Array<{ id?: string } | null | undefined> | null | undefined,
	humanizeCompatId: (id: string) => string,
): boolean {
	if (typeof alias !== "string" || !alias) return false
	if (humanizeCompatId(alias) === "") return false
	return !(providerNodes || []).some((n) => n?.id === alias)
}
