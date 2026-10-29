/**
 * Whether an Antigravity account can reach the Claude 5.5 models.
 *
 * Opus/Sonnet 5.5 sit behind Antigravity's `standard-tier`, a separate subscription
 * from Google One AI Pro. A Google One trial leaves the account on `free-tier` and
 * upstream answers 5.5 model ids with 404 — so the dashboard has to mark those models
 * from the *live* answer, never from a guess. Offering them blind produces a picker
 * where half the models fail on selection.
 *
 * Two signals, and the decision between them is the interesting part:
 *
 *   - the tier id from `loadCodeAssist`, and
 *   - the model catalogue from `fetchAvailableModels`.
 *
 * The catalogue wins. A model listed there is one upstream will accept, and tier ids
 * are undocumented strings that have changed before — a build that trusted the tier id
 * alone would start hiding models some accounts can actually use. The tier id stays as a
 * fallback for a failed catalogue probe, and `reason` says which signal decided, so a
 * support question ("why is 5.5 greyed out for me?") has an answer in the payload.
 */

/** Tier ids that unlock 5.5. A set, because the ids are undocumented and more than one appears. */
const PAID_TIER_IDS = new Set(["standard-tier", "g1-pro-tier-standard", "ultra-tier"])

/**
 * Model-id fragments that identify a Claude 5.5 model.
 *
 * Deliberately loose about the separator: upstream has spelled the same model
 * `opus-5-5`, `opus-5.5` and `opus5.5` across catalogue revisions, and a pattern that
 * accepted only the dotted form silently stopped marking 5.5 — the models reappeared in
 * the picker and then 404'd on selection. These four patterns are the pre-extraction set
 * widened, not narrowed; `tests/unit/antigravity-tier.test.ts` pins which spellings are
 * recognised exactly so a future "tidy-up" cannot quietly drop one.
 */
const CLAUDE55_HINTS = [
	/opus[-_.]?5[-_.]?5/i,
	/sonnet[-_.]?5[-_.]?5/i,
	/opus.?5\.5/i,
	/sonnet.?5\.5/i,
	/claude[-_.]?5\.5/i,
]

/** Why 5.5 is or is not available. Shown to the operator, so each value has a meaning. */
export type AntigravityTierReason =
	| "no-antigravity-connection"
	| "probe-failed"
	| "in-catalog"
	| "paid-tier"
	| "google-one-trial-only"
	| "free-tier"

export interface AntigravityTierView {
	readonly tierId: string | null
	readonly tierName: string | null
	readonly canUseClaude55: boolean
	readonly catalogHasClaude55: boolean
	readonly modelIds: readonly string[]
	readonly reason: AntigravityTierReason
}

/** The answer when there is no connection to ask. */
export function noAntigravityConnection(): AntigravityTierView {
	return {
		tierId: null,
		tierName: null,
		canUseClaude55: false,
		catalogHasClaude55: false,
		modelIds: [],
		reason: "no-antigravity-connection",
	}
}

/** Whether any id in a catalogue is a Claude 5.5 model. */
export function catalogueHasClaude55(modelIds: readonly string[]): boolean {
	return modelIds.some((id) => CLAUDE55_HINTS.some((pattern) => pattern.test(id)))
}

/**
 * Whether 5.5 is available.
 *
 * The catalogue decides when it answered; the tier id is the fallback for a failed
 * catalogue probe. An *empty* catalogue is treated as no answer rather than as "nothing
 * available" — an account that returns no models is a probing failure, and reporting it
 * as a free-tier verdict would be a wrong answer confidently given.
 */
export function canUseClaude55(input: {
	readonly tierId: string | null
	readonly modelIds: readonly string[]
}): boolean {
	if (input.modelIds.length > 0) return catalogueHasClaude55(input.modelIds)
	return input.tierId != null && PAID_TIER_IDS.has(input.tierId)
}

/**
 * The explanation shown next to the marked models.
 *
 * `google-one-trial-only` is its own reason because it is the confusing case: the
 * operator is paying for Google One and 5.5 still does not work. Saying "free tier"
 * there sends them looking for a plan they already have.
 */
export function tierReason(input: {
	readonly tierId: string | null
	readonly paidTierId: string | null
	readonly modelIds: readonly string[]
	readonly catalogueHas55: boolean
}): AntigravityTierReason {
	if (input.tierId === null && input.modelIds.length === 0) return "probe-failed"
	if (input.catalogueHas55) return "in-catalog"
	if (input.tierId != null && PAID_TIER_IDS.has(input.tierId)) return "paid-tier"
	if (input.paidTierId != null && input.paidTierId !== "free-tier") return "google-one-trial-only"
	return "free-tier"
}

/**
 * Combines both probe results into the view, computing the verdict and its reason
 * together so they cannot disagree — `canUseClaude55: false` beside `reason: "in-catalog"`
 * would leave the operator with no next step.
 */
export function presentAntigravityTier(input: {
	readonly tierId: string | null
	readonly tierName: string | null
	readonly paidTierId: string | null
	readonly modelIds: readonly string[]
}): AntigravityTierView {
	const has55 = catalogueHasClaude55(input.modelIds)
	return {
		tierId: input.tierId,
		tierName: input.tierName,
		canUseClaude55: canUseClaude55({ tierId: input.tierId, modelIds: input.modelIds }),
		catalogHasClaude55: has55,
		modelIds: input.modelIds,
		reason: tierReason({
			tierId: input.tierId,
			paidTierId: input.paidTierId,
			modelIds: input.modelIds,
			catalogueHas55: has55,
		}),
	}
}

/**
 * The payload for a failed probe.
 *
 * Status 200 on purpose: the page must render with neutral styling rather than break
 * because a tier check timed out. `error` carries the cause for a support question, and
 * `canUseClaude55: false` keeps the models marked — showing them as available on a failed
 * probe would offer models that 404.
 */
export function tierProbeFailure(error: unknown): AntigravityTierView & { error: string } {
	const message = error instanceof Error ? error.message : "tier probe failed"
	return {
		tierId: null,
		tierName: null,
		canUseClaude55: false,
		catalogHasClaude55: false,
		modelIds: [],
		reason: "probe-failed",
		error: message,
	}
}
