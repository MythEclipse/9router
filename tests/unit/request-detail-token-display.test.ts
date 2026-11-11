// RequestDetailsTab token display helpers (issue #3890).
// The component is "use client" JSX, so the pure helpers live in
// tokenDisplay.ts and are imported here directly.
import { describe, expect, it } from "vitest"
import { getInputTokens, getOutputTokens } from "@/lib/tokenDisplay"

describe("getOutputTokens — issue #3890", () => {
	it("Claude-format usage {output_tokens: 100} displays 100, not 0", () => {
		expect(getOutputTokens({ input_tokens: 50, output_tokens: 100 })).toBe(100)
	})

	it("OpenAI-format usage {completion_tokens: 100} still displays 100", () => {
		expect(getOutputTokens({ prompt_tokens: 50, completion_tokens: 100 })).toBe(100)
	})

	it("missing/empty tokens → 0, no throw", () => {
		expect(getOutputTokens(undefined)).toBe(0)
		expect(getOutputTokens(null)).toBe(0)
		expect(getOutputTokens({})).toBe(0)
		expect(() => getOutputTokens(undefined).toLocaleString()).not.toThrow()
	})

	it("input helper unchanged: Claude input_tokens fallback still works", () => {
		expect(getInputTokens({ input_tokens: 50 })).toBe(50)
	})
})
