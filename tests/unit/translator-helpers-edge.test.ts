// Locks edge cases flagged in docs 11 §1/§4 that were only covered indirectly.
import { describe, expect, it } from "vitest"
import { encodeDataUri, parseDataUri } from "../../open-sse/translator/concerns/image.js"
import { normalizeClaudePassthrough } from "../../open-sse/translator/formats/claude.js"

describe("normalizeClaudePassthrough - haiku adaptive thinking (docs 11 §1)", () => {
	it.each([
		"claude-haiku-4-5",
		"claude-haiku-4.5",
		"claude-4.5-haiku",
		"claude-3-5-haiku-20241022",
		"haiku",
	])("downgrades adaptive thinking for older/unversioned %s", (model) => {
		const out = normalizeClaudePassthrough({ thinking: { type: "adaptive" } }, model)
		expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 10000 })
	})

	it.each(["claude-haiku-5-5", "claude-5.5-haiku-20261022", "claude-haiku-6"])(
		"keeps adaptive thinking for %s",
		(model) => {
			const out = normalizeClaudePassthrough({ thinking: { type: "adaptive" } }, model)
			expect(out.thinking).toEqual({ type: "adaptive" })
		},
	)

	it("keeps adaptive thinking for Haiku 5.5 effort configuration", () => {
		const out = normalizeClaudePassthrough(
			{
				thinking: { type: "adaptive" },
				output_config: { effort: "high" },
			},
			"claude-haiku-5-5",
		)
		expect(out.thinking).toEqual({ type: "adaptive" })
		expect(out.output_config).toEqual({ effort: "high" })
	})

	it("keeps adaptive thinking for sonnet/opus", () => {
		const out = normalizeClaudePassthrough({ thinking: { type: "adaptive" } }, "claude-sonnet-4-6")
		expect(out.thinking).toEqual({ type: "adaptive" })
	})

	// 7e5f5a88 folds these into the neighbouring user turn instead of hoisting them into
	// body.system: volatile reminders ahead of the conversation broke the prefix cache.
	it("folds mid-conversation system messages into the preceding user turn", () => {
		const out = normalizeClaudePassthrough({
			messages: [
				{ role: "user", content: "hi" },
				{ role: "system", content: "be brief" },
			],
		})
		expect(out.system).toBeUndefined()
		expect(out.messages).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "hi" },
					{ type: "text", text: "be brief" },
				],
			},
		])
		expect(out.messages.every((m) => m.role !== "system")).toBe(true)
	})
})

describe("parseDataUri / encodeDataUri (docs 11 §4)", () => {
	it("parses a base64 data uri", () => {
		expect(parseDataUri("data:image/png;base64,AAAB")).toEqual({
			mimeType: "image/png",
			base64: "AAAB",
		})
	})

	it("tolerates newlines inside base64 payload", () => {
		expect(parseDataUri("data:image/jpeg;base64,AA\nBB")?.base64).toBe("AA\nBB")
	})

	it("returns null for http urls and non-strings", () => {
		expect(parseDataUri("https://x/y.png")).toBeNull()
		expect(parseDataUri(null)).toBeNull()
	})

	it("encode/parse roundtrip", () => {
		const uri = encodeDataUri("image/webp", "ZZZ")
		expect(parseDataUri(uri)).toEqual({ mimeType: "image/webp", base64: "ZZZ" })
	})
})
