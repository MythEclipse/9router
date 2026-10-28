/**
 * Pricing update rules.
 *
 * Pure. An update is a nested map — provider → model → {rate field: number} —
 * and every rejection names the exact path that failed, because the operator
 * editing a rate table needs to know which cell is wrong, not that "the body"
 * was invalid.
 */

/** The rate fields the cost calculation reads. Anything else is a typo. */
export const PRICING_FIELDS = ["input", "output", "cached", "reasoning", "cache_creation"] as const

export type PricingField = (typeof PRICING_FIELDS)[number]

/**
 * provider → model → rates.
 *
 * `input` and `output` are required because the cost calculation has no
 * fallback for them: a row priced with only a cached rate would compute a cost
 * of zero for every uncached token. The repo's own type enforces the same pair,
 * so relaxing it here would only move the failure to the database boundary.
 */
export interface ModelRates {
	input: number
	output: number
	cached?: number
	reasoning?: number
	cache_creation?: number
}

export type PricingUpdate = Record<string, Record<string, ModelRates>>

export interface PricingRejection {
	/** Dotted path of the offending value: `openai`, `openai/gpt-4o`, `…/input`. */
	readonly path: string
	readonly reason: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Validate an update body, returning the first rejection or the normalised map.
 *
 * First-only rather than collecting every error: the caller answers one 400
 * with one message, and a list of twenty paths for a body the operator pasted
 * wrong is less useful than the first one to fix.
 *
 * Rates must be finite and non-negative. `NaN` is the case worth naming: it
 * compares false against every bound, so a validation written as
 * `value < 0` alone lets it through and it poisons every cost computed from it.
 */
export function parsePricingUpdate(
	body: unknown,
): { ok: true; value: PricingUpdate } | { ok: false; error: PricingRejection } {
	if (!isPlainObject(body)) {
		return { ok: false, error: { path: "", reason: "Pricing data must be an object" } }
	}

	const value: PricingUpdate = {}

	for (const [provider, models] of Object.entries(body)) {
		if (!isPlainObject(models)) {
			return {
				ok: false,
				error: { path: provider, reason: `Pricing for provider "${provider}" must be an object` },
			}
		}

		const providerEntry: PricingUpdate[string] = {}

		for (const [model, pricing] of Object.entries(models)) {
			const where = `${provider}/${model}`
			if (!isPlainObject(pricing)) {
				return {
					ok: false,
					error: { path: where, reason: `Pricing for model "${where}" must be an object` },
				}
			}

			const modelEntry: Partial<ModelRates> = {}
			for (const [field, rate] of Object.entries(pricing)) {
				if (!(PRICING_FIELDS as readonly string[]).includes(field)) {
					return {
						ok: false,
						error: {
							path: `${where}/${field}`,
							reason: `Unknown pricing field "${field}" for ${where}`,
						},
					}
				}
				if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) {
					return {
						ok: false,
						error: {
							path: `${where}/${field}`,
							reason: `Rate for "${field}" in ${where} must be a non-negative number`,
						},
					}
				}
				modelEntry[field as PricingField] = rate
			}

			for (const required of ["input", "output"] as const) {
				if (modelEntry[required] === undefined) {
					return {
						ok: false,
						error: {
							path: `${where}/${required}`,
							reason: `Pricing for ${where} must include "${required}"`,
						},
					}
				}
			}
			providerEntry[model] = modelEntry as ModelRates
		}
		value[provider] = providerEntry
	}

	return { ok: true, value }
}

/**
 * What a reset request targets.
 *
 * `provider` alone resets every model under it — a whole price table, from a
 * query string, with no body and no confirmation. That is why the shape is
 * named here rather than inlined in the route: a caller reading this can see
 * how much a single parameter discards.
 */
export type PricingResetTarget =
	| { readonly scope: "all" }
	| { readonly scope: "provider"; readonly provider: string }
	| { readonly scope: "model"; readonly provider: string; readonly model: string }

/**
 * Read the reset target from query parameters.
 *
 * A model without a provider cannot identify anything, so it is refused rather
 * than silently treated as "reset everything" — which is what the previous
 * `if (provider && model) … else if (provider) … else …` chain did with an
 * unexpected pair.
 */
export function parsePricingResetTarget(
	provider: string | null | undefined,
	model: string | null | undefined,
): { ok: true; value: PricingResetTarget } | { ok: false; error: PricingRejection } {
	const trimmedProvider = provider?.trim() ?? ""
	const trimmedModel = model?.trim() ?? ""

	if (trimmedModel && !trimmedProvider) {
		return {
			ok: false,
			error: { path: "model", reason: "A model reset also needs the provider" },
		}
	}
	if (trimmedModel) {
		return { ok: true, value: { scope: "model", provider: trimmedProvider, model: trimmedModel } }
	}
	if (trimmedProvider) {
		return { ok: true, value: { scope: "provider", provider: trimmedProvider } }
	}
	return { ok: true, value: { scope: "all" } }
}
