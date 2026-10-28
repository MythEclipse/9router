import { describe, expect, it } from "vitest"
import { openaiToClaudeRequest } from "../../apps/web/open-sse/translator/request/openai-to-claude.js"

describe("OpenAI image content in Claude tool results", () => {
	it("converts tool-result image_url parts to Claude image blocks", () => {
		const request = openaiToClaudeRequest(
			"claude-sonnet-4",
			{
				messages: [
					{
						role: "tool",
						tool_call_id: "call-1",
						content: [
							{ type: "text", text: "screenshot" },
							{ type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
						],
					},
				],
			},
			false,
		)

		expect(request.messages).toEqual([
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "call-1",
						content: [
							{ type: "text", text: "screenshot" },
							{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
						],
					},
				],
			},
		])
	})
})
