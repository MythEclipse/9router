import { describe, expect, it } from "vitest"
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js"
import { MODEL_PRICING } from "../../open-sse/providers/pricing.js"
import antigravityRegistry from "../../open-sse/providers/registry/antigravity.js"

describe("Gemini 4 Argon Support & Config", () => {
	it("registers gemini-4-argon tiered models in antigravity provider registry", () => {
		const agIds = antigravityRegistry.models.map((m) => m.id)
		expect(agIds).toContain("gemini-4-argon-high")
		expect(agIds).toContain("gemini-4-argon-medium")
		expect(agIds).toContain("gemini-4-argon-low")
		expect(agIds).toContain("gemini-4-argon")
	})

	it("maps upstream model IDs correctly", () => {
		const models = Object.fromEntries(
			antigravityRegistry.models.map((m) => [m.id, m.upstreamModelId]),
		)
		expect(models["gemini-4-argon-high"]).toBe("gemini-4-argon-high(high)")
		expect(models["gemini-4-argon-medium"]).toBe("gemini-4-argon-medium(medium)")
		expect(models["gemini-4-argon-low"]).toBe("gemini-4-argon-low(low)")
		expect(models["gemini-4-argon"]).toBe("gemini-4-argon-medium(medium)")
	})

	it("resolves capabilities correctly for gemini-4-argon models with official limits", () => {
		const caps = getCapabilitiesForModel("antigravity", "gemini-4-argon-high")
		expect(caps.vision).toBe(true)
		expect(caps.pdf).toBe(true)
		expect(caps.reasoning).toBe(true)
		expect(caps.thinkingFormat).toBe("gemini-level")
		expect(caps.thinkingCanDisable).toBe(false)
		expect(caps.contextWindow).toBe(1048576)
		expect(caps.maxOutput).toBe(65536)
	})

	it("defines official intro pricing for gemini-4-argon models ($2/$10)", () => {
		const expectedPricing = {
			input: 2.0,
			output: 10.0,
			cached: 0.1,
			reasoning: 10.0,
			cache_creation: 2.0,
		}
		expect(MODEL_PRICING["gemini-4-argon"]).toEqual(expectedPricing)
		expect(MODEL_PRICING["gemini-4-argon-high"]).toEqual(expectedPricing)
		expect(MODEL_PRICING["gemini-4-argon-medium"]).toEqual(expectedPricing)
		expect(MODEL_PRICING["gemini-4-argon-low"]).toEqual(expectedPricing)
	})
})
