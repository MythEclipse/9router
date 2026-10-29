import { describe, expect, it } from "vitest"
import {
	canUseClaude55,
	catalogueHasClaude55,
	noAntigravityConnection,
	presentAntigravityTier,
	tierProbeFailure,
	tierReason,
} from "../../apps/api/src/domain/antigravity-tier.ts"

describe("catalogueHasClaude55", () => {
	/**
	 * The spellings upstream has published. This list is the contract: an extraction that
	 * narrows the pattern silently stops marking real 5.5 models, they reappear in the
	 * picker, and each one 404s only once the operator selects it.
	 */
	const accepted = [
		"claude-opus-5.5",
		"claude-sonnet-5.5",
		"claude-sonnet-5.5-20260101",
		"Claude-Opus-5.5",
		"opus-5-5",
		"sonnet5.5",
		"opus5.5",
		"claude-opus-5-5",
	]

	for (const id of accepted) {
		it(`recognises ${id}`, () => {
			expect(catalogueHasClaude55([id])).toBe(true)
		})
	}

	const rejected = [
		"claude-opus-4-5",
		"claude-opus-4.5",
		"gemini-3-pro",
		"gpt-5",
		"claude-haiku-5.0",
	]

	for (const id of rejected) {
		it(`does not recognise ${id}`, () => {
			expect(catalogueHasClaude55([id])).toBe(false)
		})
	}

	it("finds a match anywhere in a catalogue", () => {
		expect(catalogueHasClaude55(["gemini-3-pro", "claude-sonnet-5.5"])).toBe(true)
	})

	it("reports false for an empty catalogue", () => {
		expect(catalogueHasClaude55([])).toBe(false)
	})
})

describe("canUseClaude55", () => {
	it("lets the catalogue decide when it answered", () => {
		// Even on a free tier id, a catalogue that lists 5.5 means upstream will accept it.
		expect(canUseClaude55({ tierId: "free-tier", modelIds: ["claude-opus-5.5"] })).toBe(true)
	})

	it("falls back to the tier id when the catalogue probe failed", () => {
		expect(canUseClaude55({ tierId: "standard-tier", modelIds: [] })).toBe(true)
		expect(canUseClaude55({ tierId: "free-tier", modelIds: [] })).toBe(false)
	})

	it("does not read an empty catalogue as 'nothing available' when the tier is paid", () => {
		expect(canUseClaude55({ tierId: "ultra-tier", modelIds: [] })).toBe(true)
	})

	it("says no when neither signal answered", () => {
		expect(canUseClaude55({ tierId: null, modelIds: [] })).toBe(false)
	})

	it("treats a catalogue without 5.5 as the deciding answer", () => {
		// A paid tier id does not override a catalogue that answered and omitted 5.5.
		expect(canUseClaude55({ tierId: "standard-tier", modelIds: ["gemini-3-pro"] })).toBe(false)
	})
})

describe("tierReason", () => {
	it("reports a probe that answered nothing", () => {
		expect(tierReason({ tierId: null, paidTierId: null, modelIds: [], catalogueHas55: false })).toBe(
			"probe-failed",
		)
	})

	it("distinguishes the catalogue deciding from the tier deciding", () => {
		expect(
			tierReason({
				tierId: "free-tier",
				paidTierId: null,
				modelIds: ["claude-opus-5.5"],
				catalogueHas55: true,
			}),
		).toBe("in-catalog")
		expect(
			tierReason({
				tierId: "standard-tier",
				paidTierId: null,
				modelIds: ["gemini-3-pro"],
				catalogueHas55: false,
			}),
		).toBe("paid-tier")
	})

	it("names the Google One trial case separately, because it is the confusing one", () => {
		// The operator is paying for Google One and 5.5 still does not work; "free tier"
		// would send them looking for a plan they already own.
		expect(
			tierReason({
				tierId: "free-tier",
				paidTierId: "g1-pro-tier",
				modelIds: ["gemini-3-pro"],
				catalogueHas55: false,
			}),
		).toBe("google-one-trial-only")
	})

	it("reports a plain free tier", () => {
		expect(
			tierReason({
				tierId: "free-tier",
				paidTierId: "free-tier",
				modelIds: ["gemini-3-pro"],
				catalogueHas55: false,
			}),
		).toBe("free-tier")
	})
})

describe("presentAntigravityTier", () => {
	it("keeps the verdict and the reason consistent", () => {
		const view = presentAntigravityTier({
			tierId: "free-tier",
			tierName: "Free",
			paidTierId: "g1-pro-tier",
			modelIds: ["claude-opus-5.5"],
		})
		expect(view.canUseClaude55).toBe(true)
		expect(view.reason).toBe("in-catalog")
		expect(view.catalogHasClaude55).toBe(true)
	})

	it("carries the tier name through for display", () => {
		const view = presentAntigravityTier({
			tierId: "standard-tier",
			tierName: "Standard",
			paidTierId: null,
			modelIds: [],
		})
		expect(view.tierName).toBe("Standard")
		expect(view.reason).toBe("paid-tier")
	})

	it("never pairs a false verdict with a positive reason", () => {
		const view = presentAntigravityTier({
			tierId: null,
			tierName: null,
			paidTierId: null,
			modelIds: [],
		})
		expect(view.canUseClaude55).toBe(false)
		expect(view.reason).toBe("probe-failed")
	})
})

describe("noAntigravityConnection", () => {
	it("reports the connection as the reason, not a failed probe", () => {
		// "No account connected" and "the probe broke" need different fixes.
		expect(noAntigravityConnection()).toEqual({
			tierId: null,
			tierName: null,
			canUseClaude55: false,
			catalogHasClaude55: false,
			modelIds: [],
			reason: "no-antigravity-connection",
		})
	})
})

describe("tierProbeFailure", () => {
	it("keeps the models marked, so a broken probe cannot offer 404s", () => {
		const view = tierProbeFailure(new Error("timeout"))
		expect(view.canUseClaude55).toBe(false)
		expect(view.reason).toBe("probe-failed")
		expect(view.error).toBe("timeout")
	})

	it("words a non-Error rejection without leaking 'undefined'", () => {
		expect(tierProbeFailure(undefined).error).toBe("tier probe failed")
		expect(tierProbeFailure("nope").error).toBe("tier probe failed")
	})
})
