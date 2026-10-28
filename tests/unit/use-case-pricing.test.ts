import { describe, expect, it } from "vitest"
import type { PricingMap, PricingPort } from "../../apps/api/src/application/dependencies.ts"
import {
	makeGetPricing,
	makeResetPricing,
	makeUpdatePricing,
} from "../../apps/api/src/application/pricing/manage-pricing.ts"

function fakePort(overrides: Partial<PricingPort> = {}): PricingPort & { calls: string[] } {
	const calls: string[] = []
	const pricing: PricingMap = { openai: { "gpt-4o": { input: 2, output: 8 } } }
	return {
		calls,
		async read() {
			calls.push("read")
			return pricing
		},
		async update() {
			calls.push("update")
			return pricing
		},
		async reset(target) {
			calls.push(`reset:${target.scope}`)
			return pricing
		},
		...overrides,
	}
}

describe("getPricing", () => {
	it("delegates to the port unchanged", async () => {
		const port = fakePort()
		await expect(makeGetPricing(port)()).resolves.toEqual({
			openai: { "gpt-4o": { input: 2, output: 8 } },
		})
	})
})

describe("updatePricing", () => {
	it("applies a valid update", async () => {
		const port = fakePort()
		await makeUpdatePricing(port)({ openai: { "gpt-4o": { input: 3, output: 9 } } })
		expect(port.calls).toEqual(["update"])
	})

	it("rejects with VALIDATION and never calls the port", async () => {
		const port = fakePort()
		await expect(
			makeUpdatePricing(port)({ openai: { "gpt-4o": { input: -1, output: 1 } } }),
		).rejects.toMatchObject({ code: "VALIDATION" })
		expect(port.calls).toEqual([])
	})

	it("names the offending cell in the error detail", async () => {
		const port = fakePort()
		await expect(
			makeUpdatePricing(port)({ p: { m: { inputt: 1, output: 1 } } }),
		).rejects.toMatchObject({ detail: "p/m/inputt" })
	})
})

describe("resetPricing", () => {
	it("routes a model target to the port as a model scope", async () => {
		const port = fakePort()
		await makeResetPricing(port)("openai", "gpt-4o")
		expect(port.calls).toEqual(["reset:model"])
	})

	it("routes a lone provider to a provider scope", async () => {
		const port = fakePort()
		await makeResetPricing(port)("openai", null)
		expect(port.calls).toEqual(["reset:provider"])
	})

	it("routes neither to a full reset", async () => {
		const port = fakePort()
		await makeResetPricing(port)(null, null)
		expect(port.calls).toEqual(["reset:all"])
	})

	it("refuses a model without a provider and touches nothing", async () => {
		// The old else-chain treated this as "no provider, no model" and reset
		// every override in the table.
		const port = fakePort()
		await expect(makeResetPricing(port)(null, "gpt-4o")).rejects.toMatchObject({
			code: "VALIDATION",
		})
		expect(port.calls).toEqual([])
	})
})
