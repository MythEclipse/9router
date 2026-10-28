import { mapRecentRequests } from "@9router/db/repos/usageRepo"
import { describe, expect, it } from "vitest"

/**
 * The recent-request list carries three rules that are easy to drop during a
 * refactor: a combo must be reported by the model that served it, only billed rows
 * count, and a zero-token row is noise. Each case below fails loudly if one goes.
 */
const row = (over: Record<string, unknown> = {}) => ({
	timestamp: "2026-01-15T10:00:00.000Z",
	provider: "openai",
	model: "gpt-5",
	tokens: JSON.stringify({ prompt_tokens: 10, completion_tokens: 5 }),
	status: "ok",
	meta: null,
	...over,
})

describe("mapRecentRequests", () => {
	it("maps a plain OpenAI-shaped row", () => {
		const [entry] = mapRecentRequests([row()])
		expect(entry).toEqual({
			timestamp: "2026-01-15T10:00:00.000Z",
			model: "gpt-5",
			requestedModel: undefined,
			provider: "openai",
			promptTokens: 10,
			completionTokens: 5,
			cachedTokens: 0,
			status: "ok",
		})
	})

	it("reads Anthropic-shaped token fields", () => {
		const [entry] = mapRecentRequests([
			row({
				tokens: JSON.stringify({ input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 2 }),
			}),
		])
		expect(entry.promptTokens).toBe(7)
		expect(entry.completionTokens).toBe(3)
		expect(entry.cachedTokens).toBe(2)
	})

	it("reports the resolved model and keeps the alias beside it", () => {
		const [entry] = mapRecentRequests([
			row({ model: "my-combo", meta: JSON.stringify({ resolvedModel: "claude-sonnet-4-5" }) }),
		])
		expect(entry.model).toBe("claude-sonnet-4-5")
		expect(entry.requestedModel).toBe("my-combo")
	})

	it("does not invent an alias when the names match", () => {
		const [entry] = mapRecentRequests([
			row({ model: "gpt-5", meta: JSON.stringify({ resolvedModel: "gpt-5" }) }),
		])
		expect(entry.requestedModel).toBeUndefined()
	})

	it("drops non-billed lifecycle rows", () => {
		const rows = [row(), row({ status: "error" }), row({ status: "pending" })]
		expect(mapRecentRequests(rows)).toHaveLength(1)
	})

	it("treats a missing status as billed", () => {
		expect(mapRecentRequests([row({ status: null })])).toHaveLength(1)
	})

	it("drops rows that spent no tokens", () => {
		const rows = [row({ tokens: JSON.stringify({ prompt_tokens: 0, completion_tokens: 0 }) })]
		expect(mapRecentRequests(rows)).toHaveLength(0)
	})

	it("keeps a row that only spent prompt tokens", () => {
		const rows = [row({ tokens: JSON.stringify({ prompt_tokens: 4, completion_tokens: 0 }) })]
		expect(mapRecentRequests(rows)).toHaveLength(1)
	})

	it("applies the model allow-list to the resolved name", () => {
		const rows = [
			row({ model: "combo", meta: JSON.stringify({ resolvedModel: "claude-sonnet-4-5" }) }),
			row({ model: "gpt-5" }),
		]
		const kept = mapRecentRequests(rows, { isModelAllowed: (m) => m.startsWith("claude") })
		expect(kept.map((e) => e.model)).toEqual(["claude-sonnet-4-5"])
	})

	it("truncates to the limit after filtering", () => {
		const rows = Array.from({ length: 30 }, () => row())
		expect(mapRecentRequests(rows, { limit: 5 })).toHaveLength(5)
		expect(mapRecentRequests(rows)).toHaveLength(20)
	})

	it("survives unparseable tokens and meta without throwing", () => {
		// A broken payload maps to zero tokens, which the billed-rows rule then drops.
		// The contract is "no throw", not "keep the row".
		expect(() => mapRecentRequests([row({ tokens: "{broken", meta: "also-broken" })])).not.toThrow()
		expect(mapRecentRequests([row({ tokens: "{broken", meta: "also-broken" })])).toHaveLength(0)
		// A broken meta alone must not cost us the row's tokens.
		const [entry] = mapRecentRequests([row({ meta: "also-broken" })])
		expect(entry.model).toBe("gpt-5")
		expect(entry.promptTokens).toBe(10)
	})

	it("returns an empty list for no rows", () => {
		expect(mapRecentRequests([])).toEqual([])
	})
})

describe("matches the inline chain it replaces", () => {
	/**
	 * The pre-refactor map/filter/slice, reproduced over the same fixtures. This is
	 * the actual regression guard: the extraction must not change any field.
	 */
	function legacy(rows: any[], isModelAllowed: (m: string) => boolean, limit = 20) {
		return rows
			.map((r: any) => {
				const t = JSON.parse(r.tokens || "{}") || {}
				const meta = JSON.parse(r.meta || "{}") || {}
				const resolved = meta?.resolvedModel
				const display = typeof resolved === "string" && resolved ? resolved : r.model
				const alias = r.model && r.model !== display ? r.model : undefined
				return {
					timestamp: String(r.timestamp),
					model: display,
					requestedModel: alias,
					provider: r.provider || "",
					promptTokens: t.prompt_tokens || t.input_tokens || 0,
					completionTokens: t.completion_tokens || t.output_tokens || 0,
					cachedTokens: t.cached_tokens || t.cache_read_input_tokens || 0,
					status: r.status || "ok",
				}
			})
			.filter((e: any) => {
				if (e.status !== "ok") return false
				if (!isModelAllowed(e.model)) return false
				if (e.promptTokens === 0 && e.completionTokens === 0) return false
				return true
			})
			.slice(0, limit)
	}

	it("produces identical output on a mixed fixture set", () => {
		const allowAll = () => true
		const rows = [
			row(),
			row({ status: "error" }),
			row({ model: "combo", meta: JSON.stringify({ resolvedModel: "gpt-5" }) }),
			row({ tokens: JSON.stringify({ input_tokens: 3, output_tokens: 1 }) }),
			row({ tokens: JSON.stringify({ prompt_tokens: 0, completion_tokens: 0 }) }),
			row({ model: "claude-x", status: "ok" }),
		]
		expect(mapRecentRequests(rows, { limit: 20, isModelAllowed: allowAll })).toEqual(
			legacy(rows, allowAll),
		)
	})
})
