/**
 * Will this request blow the ceiling?
 *
 * A per-key budget already answers "how much is left today". This answers the question a client
 * asks *before* it sends a request: given what this call is about to cost, is there room? Three
 * answers are worse than useless if they are wrong:
 *
 * 1. **"allow" when the price is unknown.** An unpriced model would otherwise pass every ceiling
 *    silently, so an unknown price is its own verdict, not a permissive default.
 * 2. **"deny" for a key with no ceiling.** Absence of a cap is not a cap of zero; unlimited is
 *    the common case and must read as allowed.
 * 3. **"allow" when the estimate is junk.** `NaN` tokens compare false against every bound, so a
 *    malformed estimate would slip through a naive `estimate > headroom` check.
 */

/** What a request is expected to consume. */
export interface RequestEstimate {
	readonly promptTokens?: number | null
	readonly completionTokens?: number | null
	readonly cachedTokens?: number | null
}

/** Per-million-token rates, as `packages/pricing` reports them. */
export interface TokenRates {
	readonly input: number
	readonly output: number
	readonly cached?: number
}

export type CeilingVerdict = "allow" | "warn" | "deny" | "unknown"

export interface CeilingAnswer {
	readonly verdict: CeilingVerdict
	readonly reason: string
	/** What the request is expected to cost, or `null` when it cannot be priced. */
	readonly estimateUsd: number | null
	/** The key's ceiling, or `null` when it has none. */
	readonly capUsd: number | null
	readonly usedUsd: number
	/** Room left before the ceiling; negative once the key is over it. */
	readonly headroomUsd: number | null
	/** Spend the key would be at if this request went through. */
	readonly afterUsd: number | null
}

/** Fraction of the ceiling at which a request is allowed but flagged. */
const WARN_AT = 0.8

const finite = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value)

/** A token count, or `null` when the value cannot be trusted as one. */
function tokensOf(value: unknown): number | null {
	if (!finite(value) || value < 0) return null
	return value
}

/**
 * What a request costs at the given rates, or `null` when it cannot be priced.
 *
 * Cached prompt tokens are billed at the cached rate when one exists, matching how the usage
 * recorder charges them; charging them at the input rate would overstate every cached call.
 */
export function estimateUsdOf(estimate: RequestEstimate, rates: TokenRates | null): number | null {
	if (!rates) return null
	const prompt = tokensOf(estimate.promptTokens)
	const completion = tokensOf(estimate.completionTokens)
	if (prompt === null && completion === null) return null
	if (!finite(rates.input) || !finite(rates.output)) return null

	const cached = tokensOf(estimate.cachedTokens) ?? 0
	const billablePrompt = Math.max(0, (prompt ?? 0) - cached)
	const cachedRate = finite(rates.cached) ? rates.cached : rates.input

	const cost =
		(billablePrompt * rates.input + cached * cachedRate + (completion ?? 0) * rates.output) /
		1_000_000

	return Number.isFinite(cost) && cost >= 0 ? cost : null
}

/** A ceiling, or `null` when the value does not describe one. */
export function capOf(value: unknown): number | null {
	if (!finite(value) || value <= 0) return null
	return value
}

/**
 * The verdict for one request.
 *
 * `usedUsd` is what the key has already spent today; a key already over its ceiling is denied
 * whatever the estimate says, because the next request is not the one that broke it.
 */
export function ceilingAnswer(input: {
	readonly estimate: RequestEstimate
	readonly rates: TokenRates | null
	readonly capUsd: unknown
	readonly usedUsd: unknown
}): CeilingAnswer {
	const cap = capOf(input.capUsd)
	const used = finite(input.usedUsd) ? Math.max(0, input.usedUsd) : 0
	const estimateUsd = estimateUsdOf(input.estimate, input.rates)

	if (cap === null) {
		return {
			verdict: "allow",
			reason: "this key has no spending ceiling",
			estimateUsd,
			capUsd: null,
			usedUsd: used,
			headroomUsd: null,
			afterUsd: null,
		}
	}

	const headroom = cap - used
	if (estimateUsd === null) {
		return {
			verdict: "unknown",
			reason: "this request cannot be priced, so its cost against the ceiling is unknown",
			estimateUsd: null,
			capUsd: cap,
			usedUsd: used,
			headroomUsd: headroom,
			afterUsd: null,
		}
	}

	const after = used + estimateUsd
	const base = { estimateUsd, capUsd: cap, usedUsd: used, headroomUsd: headroom, afterUsd: after }

	if (headroom <= 0) {
		return { ...base, verdict: "deny", reason: "this key is already at or over its ceiling" }
	}
	if (after > cap) {
		return { ...base, verdict: "deny", reason: "this request would exceed the key's ceiling" }
	}
	if (after >= cap * WARN_AT) {
		return {
			...base,
			verdict: "warn",
			reason: "this request would leave less than 20% of the ceiling",
		}
	}
	return { ...base, verdict: "allow", reason: "there is room under the key's ceiling" }
}
