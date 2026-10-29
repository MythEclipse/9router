/**
 * Model-alias rules.
 *
 * Two handlers write aliases and they disagreed:
 *
 *  - `PUT /api/models` keyed the map by **model** (`setModelAlias(model, alias)`)
 *    and refused an alias another model already used.
 *  - `PUT /api/models/alias` keyed it by **alias** (`setModelAlias(alias, model)`)
 *    and accepted any alias, so the same request produced a different map entry
 *    depending on which URL the dashboard happened to call.
 *
 * The second is the shape the readers use (`aliases[fullModel]` resolves a model
 * to its display alias), so it is the one kept. The duplicate check comes from
 * the first, because it prevents the state that made `aliases` ambiguous.
 *
 * The reconcile step is easy to get backwards. When an alias is re-pointed, the
 * alias *name* does not move; the model it resolves to does. So a key that
 * pinned the old target has to follow the alias to the new one - that is the
 * rename `reconcileAllowedModels` is told about, not a removal.
 */

export type AliasRefusal = { code: "VALIDATION"; message: string }

/** Aliases and the model each one resolves to, keyed by alias name. */
export type AliasMap = Record<string, string>

export function validateAliasInput({
	model,
	alias,
}: {
	model: unknown
	alias: unknown
}): AliasRefusal | null {
	if (typeof model !== "string" || !model.trim() || typeof alias !== "string" || !alias.trim()) {
		return { code: "VALIDATION", message: "Model and alias required" }
	}
	return null
}

/**
 * The reconcile call owed to an alias re-point, or null when nothing moved.
 *
 * `previous` is what the alias resolved to before; `model` is what it resolves
 * to now. Only a genuine change produces work.
 */
export function reconcileForAliasRepoint(
	previous: string | undefined,
	model: string,
): { renamed: Record<string, string> } | null {
	if (!previous || previous === model) return null
	return { renamed: { [previous.toLowerCase()]: model } }
}
