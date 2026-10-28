import { describe, expect, it } from "vitest"
import { parsePricingResetTarget, parsePricingUpdate } from "../../apps/api/src/domain/pricing.ts"

describe("parsePricingUpdate", () => {
	it("accepts a well-formed nested update", () => {
		const result = parsePricingUpdate({
			openai: { "gpt-4o": { input: 2.5, output: 10, cached: 1.25 } },
		})
		expect(result).toEqual({
			ok: true,
			value: { openai: { "gpt-4o": { input: 2.5, output: 10, cached: 1.25 } } },
		})
	})

	it("accepts every field the cost calculation reads", () => {
		const all = { input: 1, output: 2, cached: 3, reasoning: 4, cache_creation: 5 }
		expect(parsePricingUpdate({ p: { m: all } }).ok).toBe(true)
	})

	it("accepts zero, which is a real rate (a free model)", () => {
		expect(parsePricingUpdate({ local: { llama: { input: 0, output: 0 } } }).ok).toBe(true)
	})

	it("requires input and output on every model", () => {
		// The cost calculation has no fallback for either: a row priced with only
		// a cached rate computes zero for every uncached token.
		for (const partial of [{ input: 1 }, { output: 1 }, { cached: 0.5 }]) {
			const result = parsePricingUpdate({ p: { m: partial } })
			expect(result.ok, JSON.stringify(partial)).toBe(false)
		}
	})

	it("rejects a non-object body", () => {
		for (const junk of [null, undefined, "x", 42, [], true]) {
			const result = parsePricingUpdate(junk)
			expect(result.ok, String(junk)).toBe(false)
		}
	})

	it("rejects a provider whose value is not an object", () => {
		const result = parsePricingUpdate({ openai: 5 })
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error.path).toBe("openai")
	})

	it("rejects a model whose value is not an object", () => {
		const result = parsePricingUpdate({ openai: { "gpt-4o": "cheap" } })
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error.path).toBe("openai/gpt-4o")
	})

	it("names the offending cell for an unknown field", () => {
		const result = parsePricingUpdate({ openai: { "gpt-4o": { inputt: 1, output: 1 } } })
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.error.path).toBe("openai/gpt-4o/inputt")
			expect(result.error.reason).toContain("inputt")
		}
	})

	it("rejects NaN, negatives, and non-numbers", () => {
		// NaN is the case that matters: `rate < 0` is false for it, so a
		// validation written as just a lower bound lets it through and it then
		// poisons every cost derived from that model.
		for (const bad of [Number.NaN, -1, -0.01, Number.POSITIVE_INFINITY, "2.5", null]) {
			const result = parsePricingUpdate({ openai: { "gpt-4o": { input: bad, output: 1 } } })
			expect(result.ok, String(bad)).toBe(false)
		}
	})
})

describe("parsePricingResetTarget", () => {
	it("targets everything when nothing is named", () => {
		expect(parsePricingResetTarget(null, null)).toEqual({ ok: true, value: { scope: "all" } })
		expect(parsePricingResetTarget("", "")).toEqual({ ok: true, value: { scope: "all" } })
	})

	it("targets one provider", () => {
		expect(parsePricingResetTarget("openai", null)).toEqual({
			ok: true,
			value: { scope: "provider", provider: "openai" },
		})
	})

	it("targets one model", () => {
		expect(parsePricingResetTarget("openai", "gpt-4o")).toEqual({
			ok: true,
			value: { scope: "model", provider: "openai", model: "gpt-4o" },
		})
	})

	it("refuses a model without a provider instead of resetting everything", () => {
		// The old else-chain fell through to resetAllPricing here: a caller who
		// passed `?model=x` and forgot the provider wiped the whole table.
		const result = parsePricingResetTarget(null, "gpt-4o")
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.error.path).toBe("model")
	})

	it("treats whitespace-only parameters as absent", () => {
		expect(parsePricingResetTarget("  ", "  ")).toEqual({ ok: true, value: { scope: "all" } })
	})
})
