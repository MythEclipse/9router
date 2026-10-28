import { describe, expect, it } from "vitest"
import { filterToOpenAIFormat } from "../../open-sse/translator/formats/openai.js"
import { FORMATS } from "../../open-sse/translator/formats.js"
import { translateRequest } from "../../open-sse/translator/index.js"
import { claudeToOpenAIRequest } from "../../open-sse/translator/request/claude-to-openai.js"
import { openaiToOllamaRequest } from "../../open-sse/translator/request/openai-to-ollama.js"
import { parseSSELine } from "../../open-sse/utils/streamHelpers.js"

describe("request normalization", () => {
	// OpenAI content is an array of typed parts. Text-only arrays are NOT
	// flattened to a string here: that would destroy the block structure that
	// multimodal and tool blocks rely on. Each target translator normalizes for
	// itself — openai-to-ollama.js::normalizeContent() flattens because ollama
	// only accepts strings, and leaves the shared bridge alone.
	it("claudeToOpenAIRequest keeps text-only content as a typed array", () => {
		const body = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "hi" },
						{ type: "text", text: "there" },
					],
				},
			],
		}

		const result = claudeToOpenAIRequest("gpt-oss:120b", body, true)
		expect(result.messages[0].content).toEqual([
			{ type: "text", text: "hi" },
			{ type: "text", text: "there" },
		])
	})

	it("claudeToOpenAIRequest preserves multimodal arrays", () => {
		const body = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "describe" },
						{
							type: "image",
							source: {
								type: "base64",
								media_type: "image/png",
								data: "ZmFrZQ==",
							},
						},
					],
				},
			],
		}

		const result = claudeToOpenAIRequest("gpt-4o", body, true)
		expect(Array.isArray(result.messages[0].content)).toBe(true)
	})

	it("filterToOpenAIFormat preserves text-only arrays as typed parts", () => {
		const body = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "a" },
						{ type: "text", text: "b" },
					],
				},
			],
		}

		const result = filterToOpenAIFormat(JSON.parse(JSON.stringify(body)))
		expect(result.messages[0].content).toEqual([
			{ type: "text", text: "a" },
			{ type: "text", text: "b" },
		])
	})

	it("translateRequest keeps /v1/messages Claude->OpenAI text payloads as typed parts", () => {
		const body = {
			model: "ollama/gpt-oss:120b",
			system: [{ type: "text", text: "You are helpful." }],
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "hello" },
						{ type: "text", text: "world" },
					],
				},
			],
			stream: true,
		}

		const result = translateRequest(
			FORMATS.CLAUDE,
			FORMATS.OPENAI,
			"gpt-oss:120b",
			JSON.parse(JSON.stringify(body)),
			true,
			null,
			"ollama",
		)

		const userMessage = result.messages.find((m) => m.role === "user")
		expect(userMessage.content).toEqual([
			{ type: "text", text: "hello" },
			{ type: "text", text: "world" },
		])
	})

	it("translateRequest strips unsupported Anthropic output_config for MiniMax Claude-compatible endpoints", () => {
		const body = {
			model: "MiniMax-M2.7",
			system: [{ type: "text", text: "You are helpful." }],
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "continue" }],
				},
			],
			max_tokens: 1024,
			output_config: {
				effort: "medium",
				format: {
					type: "json_schema",
					schema: {
						type: "object",
						properties: { title: { type: "string" } },
						required: ["title"],
						additionalProperties: false,
					},
				},
			},
		}

		const result = translateRequest(
			FORMATS.CLAUDE,
			FORMATS.CLAUDE,
			"MiniMax-M2.7",
			JSON.parse(JSON.stringify(body)),
			true,
			null,
			"minimax",
		)

		expect(result.output_config).toBeUndefined()
		expect(result.messages[0].content[0].text).toBe("continue")
	})

	it("translateRequest preserves output_config for Anthropic Claude", () => {
		const body = {
			model: "claude-sonnet-4.5",
			system: [{ type: "text", text: "You are helpful." }],
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "continue" }],
				},
			],
			max_tokens: 1024,
			output_config: {
				format: { type: "json_schema", schema: { type: "object" } },
			},
		}

		const result = translateRequest(
			FORMATS.CLAUDE,
			FORMATS.CLAUDE,
			"claude-sonnet-4.5",
			JSON.parse(JSON.stringify(body)),
			true,
			null,
			"claude",
		)

		expect(result.output_config).toEqual(body.output_config)
	})

	// Each target normalizes its own content shape. ollama only accepts string
	// content, so the flattening the shared bridge deliberately does not do is
	// done here — at the boundary that requires it.
	it("openai-to-ollama flattens a text-only array to a string", () => {
		const result = openaiToOllamaRequest(
			"gpt-oss:120b",
			{
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "hi" },
							{ type: "text", text: "there" },
						],
					},
				],
			},
			true,
		)

		expect(result.messages[0].content).toBe("hi\nthere")
	})

	it("parseSSELine supports provider raw NDJSON stream lines", () => {
		const raw = JSON.stringify({
			model: "gpt-oss:120b",
			message: { role: "assistant", content: "hello" },
			done: false,
		})

		// NDJSON is opt-in via the target format: the shared SSE path only treats a
		// leading "d" as a data line, so raw JSON needs FORMATS.OLLAMA passed in
		// (which is what stream.js does with targetFormat).
		expect(parseSSELine(raw, FORMATS.OLLAMA)).toEqual({
			model: "gpt-oss:120b",
			message: { role: "assistant", content: "hello" },
			done: false,
		})
	})

	it("parseSSELine ignores raw NDJSON without an explicit format", () => {
		const raw = JSON.stringify({ model: "gpt-oss:120b", done: false })

		// Without the format hint a bare JSON line is not a data line, so it is
		// dropped rather than mis-parsed as SSE.
		expect(parseSSELine(raw)).toBeNull()
	})

	it("parseSSELine still supports SSE data lines", () => {
		const parsed = parseSSELine('data: {"choices":[{"delta":{"content":"hi"}}]}')
		expect(parsed.choices[0].delta.content).toBe("hi")
	})
})
