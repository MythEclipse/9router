// Token labels in the request-details tab must read BOTH storage shapes.
//
// The table and drawer read output through `completion_tokens` only, so every row
// recorded from an Anthropic-shaped upstream rendered "Output Tokens: 0" even when
// the stored response held a complete 377-token answer. Input had a shape-tolerant
// helper; output did not. These assertions import the real helpers the component
// uses, so a divergence between test and UI fails here.
import { describe, expect, it } from "vitest"
import {
	getCacheCreationTokens,
	getCachedTokens,
	getInputTokens,
	getOutputTokens,
} from "@/lib/tokenDisplay"

const anthropicRow = {
	input_tokens: 548,
	output_tokens: 377,
	cache_read_input_tokens: 244736,
}

const openaiRow = {
	prompt_tokens: 1000,
	completion_tokens: 250,
	prompt_tokens_details: { cached_tokens: 800 },
}

describe("getOutputTokens", () => {
	it("reads output_tokens from an Anthropic-shaped row", () => {
		expect(getOutputTokens(anthropicRow)).toBe(377)
	})

	it("reads completion_tokens from an OpenAI-shaped row", () => {
		expect(getOutputTokens(openaiRow)).toBe(250)
	})

	it("prefers completion_tokens when both are present", () => {
		expect(getOutputTokens({ completion_tokens: 12, output_tokens: 99 })).toBe(12)
	})

	it("keeps a genuine zero as zero", () => {
		expect(getOutputTokens({ output_tokens: 0 })).toBe(0)
	})

	it("returns 0 for missing tokens instead of NaN", () => {
		expect(getOutputTokens(undefined)).toBe(0)
		expect(getOutputTokens(null)).toBe(0)
		expect(getOutputTokens({})).toBe(0)
	})

	it("never renders NaN in the table", () => {
		expect(Number.isNaN(getOutputTokens({}))).toBe(false)
	})
})

describe("getInputTokens", () => {
	it("adds cache-exclusive input_tokens to the cached reads", () => {
		// 548 fresh + 244,736 cached — reporting max() duplicated the Cached column and
		// hid the fresh tokens entirely.
		expect(getInputTokens(anthropicRow)).toBe(245284)
	})

	it("includes cache creation in the prompt total", () => {
		expect(
			getInputTokens({
				input_tokens: 100,
				cache_read_input_tokens: 900,
				cache_creation_input_tokens: 50,
			}),
		).toBe(1050)
	})

	it("does not double count OpenAI prompt_tokens that already include the cache", () => {
		expect(getInputTokens(openaiRow)).toBe(1000)
	})

	it("keeps the legacy cache-larger-than-prompt fallback", () => {
		expect(getInputTokens({ prompt_tokens: 10, cached_tokens: 200 })).toBe(200)
	})

	it("returns 0 when nothing is recorded", () => {
		expect(getInputTokens(undefined)).toBe(0)
		expect(getInputTokens({})).toBe(0)
	})
})

describe("cached-token helpers", () => {
	it("reads cache_read_input_tokens", () => {
		expect(getCachedTokens(anthropicRow)).toBe(244736)
	})

	it("reads nested OpenAI prompt_tokens_details.cached_tokens", () => {
		expect(getCachedTokens(openaiRow)).toBe(800)
	})

	it("reads cache_creation from either shape", () => {
		expect(getCacheCreationTokens({ cache_creation_input_tokens: 42 })).toBe(42)
		expect(getCacheCreationTokens({ prompt_tokens_details: { cache_creation_tokens: 7 } })).toBe(7)
	})

	it("returns 0 when absent", () => {
		expect(getCachedTokens({})).toBe(0)
		expect(getCacheCreationTokens({})).toBe(0)
	})
})

describe("the component uses these helpers, not raw property reads", () => {
	it("never reads completion_tokens directly", async () => {
		const { readFileSync } = await import("node:fs")
		const { fileURLToPath } = await import("node:url")
		const { dirname, resolve } = await import("node:path")
		const here = dirname(fileURLToPath(import.meta.url))
		const source = readFileSync(
			resolve(
				here,
				"../../apps/web/src/app/(dashboard)/dashboard/usage/components/RequestDetailsTab.tsx",
			),
			"utf8",
		)
		// A raw read bypasses the Anthropic fallback and prints 0 for those rows.
		expect(source).not.toMatch(/tokens\?\.completion_tokens\?\.toLocaleString/)
		expect(source).toMatch(/getOutputTokens\(/)
	})
})
