/**
 * The spending-ceiling preflight: three verdicts that must not be permissive.
 *
 * An unpriced model, a key with no cap, and a junk token count each used to fall through a
 * naive `estimate > headroom` comparison as "allow". They are separate answers here.
 */

import { type CeilingPorts, makeCostCeiling } from "9router-api/application/usage/cost-ceiling"
import { capOf, ceilingAnswer, estimateUsdOf } from "9router-api/domain/cost-ceiling"
import { describe, expect, it } from "vitest"

/** $1 per million in, $2 per million out. */
const rates = { input: 1, output: 2, cached: 0.5 }

describe("estimateUsdOf", () => {
	it("prices prompt and completion tokens at their own rates", () => {
		// 1M in ($1) + 1M out ($2)
		expect(
			estimateUsdOf({ promptTokens: 1_000_000, completionTokens: 1_000_000 }, rates),
		).toBeCloseTo(3, 10)
	})

	it("bills cached prompt tokens at the cached rate", () => {
		// 1M prompt of which 1M cached: $0.50, not $1.00
		expect(estimateUsdOf({ promptTokens: 1_000_000, cachedTokens: 1_000_000 }, rates)).toBeCloseTo(
			0.5,
			10,
		)
	})

	it("answers null when there are no rates at all", () => {
		expect(estimateUsdOf({ promptTokens: 10 }, null)).toBeNull()
	})

	it("answers null for a token count that is not a count", () => {
		expect(estimateUsdOf({ promptTokens: Number.NaN }, rates)).toBeNull()
		expect(estimateUsdOf({ promptTokens: -5 }, rates)).toBeNull()
		expect(estimateUsdOf({}, rates)).toBeNull()
	})
})

describe("capOf", () => {
	it("treats an absent or non-positive ceiling as no ceiling", () => {
		expect(capOf(null)).toBeNull()
		expect(capOf(0)).toBeNull()
		expect(capOf(-3)).toBeNull()
		expect(capOf(Number.POSITIVE_INFINITY)).toBeNull()
		expect(capOf(5)).toBe(5)
	})
})

describe("ceilingAnswer", () => {
	const answer = (over: Partial<Parameters<typeof ceilingAnswer>[0]> = {}) =>
		ceilingAnswer({
			estimate: { promptTokens: 100_000, completionTokens: 100_000 },
			rates,
			capUsd: 10,
			usedUsd: 0,
			...over,
		})

	it("allows a request with room to spare", () => {
		const verdict = answer()

		expect(verdict.verdict).toBe("allow")
		expect(verdict.estimateUsd).toBeCloseTo(0.3, 10)
		expect(verdict.headroomUsd).toBe(10)
	})

	it("warns once the request would leave less than 20%", () => {
		expect(answer({ usedUsd: 7.9 }).verdict).toBe("warn")
	})

	it("denies a request that would cross the ceiling", () => {
		expect(answer({ usedUsd: 9.9 }).verdict).toBe("deny")
	})

	it("denies everything once the key is already over, whatever the estimate", () => {
		const verdict = answer({ usedUsd: 12, estimate: { promptTokens: 0 } })

		expect(verdict.verdict).toBe("deny")
		expect(verdict.reason).toMatch(/already at or over/)
		expect(verdict.headroomUsd).toBe(-2)
	})

	it("allows without a ceiling, and says there is none", () => {
		const verdict = answer({ capUsd: null, usedUsd: 500 })

		expect(verdict.verdict).toBe("allow")
		expect(verdict.capUsd).toBeNull()
		expect(verdict.headroomUsd).toBeNull()
	})

	it("answers unknown rather than allow when the model has no rates", () => {
		// The failure this prevents: an unpriced model passes every ceiling silently.
		const verdict = answer({ rates: null })

		expect(verdict.verdict).toBe("unknown")
		expect(verdict.estimateUsd).toBeNull()
	})

	it("counts a junk used-spend as zero instead of denying on it", () => {
		const verdict = answer({ usedUsd: Number.NaN })

		expect(verdict.verdict).toBe("allow")
		expect(verdict.usedUsd).toBe(0)
	})
})

function ports(over: Partial<CeilingPorts> = {}): CeilingPorts {
	return {
		budgetOf: async () => ({ kind: "usd", cap: 10, used: 1 }),
		ratesOf: () => rates,
		...over,
	}
}

const question = {
	keyId: "k1",
	provider: "claude",
	model: "claude-3-5-sonnet",
	estimate: { promptTokens: 1000, completionTokens: 1000 },
}

describe("makeCostCeiling", () => {
	it("answers from the key's budget and the model's rates", async () => {
		const verdict = await makeCostCeiling(ports()).check(question)

		expect(verdict.verdict).toBe("allow")
		expect(verdict.capUsd).toBe(10)
		expect(verdict.usedUsd).toBe(1)
	})

	it("refuses to convert a token budget into dollars", async () => {
		// There is no exchange rate between tokens and money; inventing one answers a question
		// about money with a number about tokens.
		const verdict = await makeCostCeiling(
			ports({ budgetOf: async () => ({ kind: "token", cap: 1_000_000, used: 10 }) }),
		).check(question)

		expect(verdict.verdict).toBe("unknown")
		expect(verdict.reason).toMatch(/measured in token/)
	})

	it("allows when the key has no budget row at all", async () => {
		const verdict = await makeCostCeiling(ports({ budgetOf: async () => null })).check(question)

		expect(verdict.verdict).toBe("allow")
		expect(verdict.capUsd).toBeNull()
	})

	it("answers unknown for an unpriced model", async () => {
		const verdict = await makeCostCeiling(ports({ ratesOf: () => null })).check(question)

		expect(verdict.verdict).toBe("unknown")
	})
})
