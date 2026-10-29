import { describe, expect, it } from "vitest"
import {
	buildLeaderboard,
	classifyErrors,
	type ErrorAggregateRow,
	formatPercent,
	isSuccessStatus,
	LEADERBOARD_MODEL_LIMIT,
	TOP_ERROR_MODEL_LIMIT,
} from "../../apps/api/src/domain/usage-derivations.ts"

const allowAll = () => true

describe("isSuccessStatus", () => {
	it("treats the recorded success statuses as successes", () => {
		expect(isSuccessStatus("ok")).toBe(true)
		expect(isSuccessStatus("success")).toBe(true)
		expect(isSuccessStatus("200")).toBe(true)
	})

	it("ignores case, which is where the two endpoints disagreed", () => {
		// The leaderboard compared `IN ('ok','200','success')` case-sensitively, so an "OK"
		// row was a success there and an error in the error panel.
		expect(isSuccessStatus("OK")).toBe(true)
		expect(isSuccessStatus("Success")).toBe(true)
	})

	it("treats an absent status as success, because the gateway only records failures", () => {
		expect(isSuccessStatus(null)).toBe(true)
		expect(isSuccessStatus(undefined)).toBe(true)
		expect(isSuccessStatus("")).toBe(true)
	})

	it("treats a real failure as a failure", () => {
		expect(isSuccessStatus("500")).toBe(false)
		expect(isSuccessStatus("error")).toBe(false)
		expect(isSuccessStatus("429")).toBe(false)
	})
})

describe("formatPercent", () => {
	it("reports one decimal, as the badge prints it", () => {
		expect(formatPercent(1, 3)).toBe("33.3")
		expect(formatPercent(10, 10)).toBe("100.0")
	})

	it("reports 0.0 rather than NaN for zero traffic", () => {
		// `(0/0).toFixed(1)` is "NaN", which renders literally as "NaN%".
		expect(formatPercent(0, 0)).toBe("0.0")
		expect(formatPercent(5, 0)).toBe("0.0")
	})
})

describe("classifyErrors", () => {
	const rows: ErrorAggregateRow[] = [
		{ status: "ok", model: "gpt-5", count: 90, totalTokens: 900 },
		{ status: "500", model: "gpt-5", count: 8, totalTokens: 80 },
		{ status: "429", model: "claude", count: 2, totalTokens: 20 },
	]

	it("counts successes in the denominator and errors separately", () => {
		const result = classifyErrors(rows, allowAll)
		expect(result.total).toBe(100)
		expect(result.errors).toBe(10)
		expect(result.errorRate).toBe("10.0")
	})

	it("groups errors by status and by model", () => {
		const result = classifyErrors(rows, allowAll)
		expect(result.byStatus).toEqual({
			"500": { count: 8, totalTokens: 80 },
			"429": { count: 2, totalTokens: 20 },
		})
		expect(result.topErrorModels).toEqual([
			{ model: "gpt-5", errors: 8, totalTokens: 80 },
			{ model: "claude", errors: 2, totalTokens: 20 },
		])
	})

	it("drops out-of-scope models before they reach the denominator", () => {
		// Counting them in `total` but not in `errors` would understate a restricted key's rate.
		const result = classifyErrors(rows, (model) => model === "gpt-5")
		expect(result.total).toBe(98)
		expect(result.errors).toBe(8)
	})

	it("orders the top error models by error count and keeps the limit", () => {
		const many: ErrorAggregateRow[] = Array.from({ length: 30 }, (_, index) => ({
			status: "500",
			model: `model-${index}`,
			count: index,
			totalTokens: 1,
		}))
		const result = classifyErrors(many, allowAll)
		expect(result.topErrorModels).toHaveLength(TOP_ERROR_MODEL_LIMIT)
		expect(result.topErrorModels[0]?.model).toBe("model-29")
	})

	it("survives a row with no model", () => {
		const result = classifyErrors([{ status: "500", count: 1, totalTokens: 1 }], allowAll)
		expect(result.topErrorModels[0]?.model).toBe("unknown")
	})

	it("reports an empty range as zero, not NaN", () => {
		expect(classifyErrors([], allowAll)).toMatchObject({ total: 0, errors: 0, errorRate: "0.0" })
	})
})

describe("buildLeaderboard", () => {
	const rows = [
		{
			model: "gpt-5",
			provider: "openai",
			requests: 10,
			successes: 9,
			totalTokens: 1000,
			totalCost: 1,
		},
		{
			model: "claude",
			provider: "anthropic",
			requests: 30,
			successes: 30,
			totalTokens: 300,
			totalCost: 2,
		},
	]

	it("orders by request count, most used first", () => {
		expect(buildLeaderboard(rows, allowAll).map((entry) => entry.model)).toEqual(["claude", "gpt-5"])
	})

	it("computes the success rate and average tokens per request", () => {
		const gpt = buildLeaderboard(rows, allowAll).find((entry) => entry.model === "gpt-5")
		expect(gpt).toMatchObject({ successRate: "90.0", avgTokensPerRequest: 100 })
	})

	it("reports zero average for a model with no requests instead of NaN", () => {
		const entry = buildLeaderboard(
			[{ model: "rare", requests: 0, successes: 0, totalTokens: 0 }],
			allowAll,
		)[0]
		expect(entry?.avgTokensPerRequest).toBe(0)
		expect(entry?.successRate).toBe("0.0")
	})

	it("skips rows with no model name", () => {
		expect(buildLeaderboard([{ requests: 5 }, { model: "" }], allowAll)).toEqual([])
	})

	it("filters by scope before applying the limit", () => {
		// Slicing first would leave a restricted session with fewer rows than it may see.
		const many = Array.from({ length: 60 }, (_, index) => ({
			model: index === 59 ? "allowed" : `other-${index}`,
			requests: index,
		}))
		const entries = buildLeaderboard(many, (model) => model === "allowed")
		expect(entries).toHaveLength(1)
		expect(entries[0]?.model).toBe("allowed")
	})

	it("keeps the table width", () => {
		const many = Array.from({ length: 80 }, (_, index) => ({ model: `m${index}`, requests: index }))
		expect(buildLeaderboard(many, allowAll)).toHaveLength(LEADERBOARD_MODEL_LIMIT)
	})

	it("defaults a missing provider to an empty string", () => {
		expect(buildLeaderboard([{ model: "x", requests: 1 }], allowAll)[0]?.provider).toBe("")
	})
})
