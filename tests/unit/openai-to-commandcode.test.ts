/**
 * Unit tests for open-sse/translator/request/openai-to-commandcode.js
 *
 * Verified live against upstream `/alpha/generate` (curl, 2026-05-07):
 *  - params.system: STRING at top level (Anthropic-style; "system" role NOT in messages[])
 *  - params.messages[*].role ∈ {"user","assistant","tool"}
 *  - params.messages[*].content: Array<content_block> (NEVER string)
 *  - tools[*]: Anthropic plain {name, description, input_schema}
 */

import { describe, expect, it } from "vitest"
import { openaiToCommandCodeRequest } from "../../apps/web/open-sse/translator/request/openai-to-commandcode.js"

const MODEL = "moonshotai/Kimi-K2.6"

describe("openaiToCommandCodeRequest - basic envelope", () => {
	it("returns the expected top-level envelope shape", () => {
		const out = openaiToCommandCodeRequest(
			MODEL,
			{
				messages: [{ role: "user", content: "hi" }],
			},
			true,
		)

		expect(out).toHaveProperty("threadId")
		expect(out).toHaveProperty("memory")
		expect(out).toHaveProperty("config")
		expect(out).toHaveProperty("params")
		expect(out.params.model).toBe(MODEL)
		expect(out.params.stream).toBe(true)
	})
})

describe("openaiToCommandCodeRequest - system handling", () => {
	it("hoists system messages to params.system (string), not messages[]", () => {
		const out = openaiToCommandCodeRequest(
			MODEL,
			{
				messages: [
					{ role: "system", content: "You are concise." },
					{ role: "user", content: "hi" },
				],
			},
			true,
		)

		expect(typeof out.params.system).toBe("string")
		expect(out.params.system).toBe("You are concise.")
		const roles = out.params.messages.map((m) => m.role)
		expect(roles).not.toContain("system")
	})

	it("joins multiple system messages with blank line", () => {
		const out = openaiToCommandCodeRequest(
			MODEL,
			{
				messages: [
					{ role: "system", content: "A" },
					{ role: "system", content: "B" },
					{ role: "user", content: "hi" },
				],
			},
			true,
		)

		expect(out.params.system).toBe("A\n\nB")
	})

	it("omits params.system when no system messages", () => {
		const out = openaiToCommandCodeRequest(
			MODEL,
			{
				messages: [{ role: "user", content: "hi" }],
			},
			true,
		)
		expect(out.params.system).toBeUndefined()
	})
})

describe("openaiToCommandCodeRequest - content shape", () => {
	it("MUST always emit content as Array (never string) for user", () => {
		const out = openaiToCommandCodeRequest(
			MODEL,
			{
				messages: [{ role: "user", content: "hello" }],
			},
			true,
		)

		const u = out.params.messages[0]
		expect(Array.isArray(u.content)).toBe(true)
		expect(u.content[0]).toEqual({ type: "text", text: "hello" })
	})

	it("MUST always emit content as Array for assistant", () => {
		const out = openaiToCommandCodeRequest(
			MODEL,
			{
				messages: [
					{ role: "user", content: "a" },
					{ role: "assistant", content: "b" },
				],
			},
			true,
		)
		const a = out.params.messages[1]
		expect(Array.isArray(a.content)).toBe(true)
		expect(a.content[0]).toEqual({ type: "text", text: "b" })
	})
})

describe("openaiToCommandCodeRequest - tool role / tool-result (AI SDK)", () => {
	it('converts role:"tool" to role:"tool" with tool-result block; output is {type:"text",value}', () => {
		const out = openaiToCommandCodeRequest(
			MODEL,
			{
				messages: [
					{ role: "user", content: "run X" },
					{
						role: "assistant",
						content: null,
						tool_calls: [
							{ id: "call_1", type: "function", function: { name: "do_x", arguments: '{"a":1}' } },
						],
					},
					{ role: "tool", tool_call_id: "call_1", name: "do_x", content: "RESULT_OK" },
				],
			},
			true,
		)

		const toolMsg = out.params.messages[out.params.messages.length - 1]
		expect(toolMsg.role).toBe("tool")
		const block = toolMsg.content[0]
		expect(block.type).toBe("tool-result")
		expect(block.toolCallId).toBe("call_1")
		expect(block.toolName).toBe("do_x")
		expect(block.output).toEqual({ type: "text", value: "RESULT_OK" })
	})
})

describe("openaiToCommandCodeRequest - assistant tool_calls / tool-call", () => {
	it("converts assistant.tool_calls[] into content blocks of type tool-call", () => {
		const out = openaiToCommandCodeRequest(
			MODEL,
			{
				messages: [
					{ role: "user", content: "go" },
					{
						role: "assistant",
						content: null,
						tool_calls: [
							{ id: "call_42", type: "function", function: { name: "search", arguments: '{"q":"hi"}' } },
						],
					},
				],
			},
			true,
		)

		const asst = out.params.messages[1]
		expect(asst.role).toBe("assistant")
		const tc = asst.content.find((b) => b.type === "tool-call")
		expect(tc).toBeDefined()
		expect(tc.toolCallId).toBe("call_42")
		expect(tc.toolName).toBe("search")
		expect(tc.input).toEqual({ q: "hi" })
	})
})

describe("openaiToCommandCodeRequest - tool identity (CLI 1.88.5)", () => {
	it("recovers the tool name for a role:tool turn that omits it", () => {
		// Claude Code and the OpenAI SDK send tool results without a name; the CLI
		// rejects the request when toolName is empty.
		const out = openaiToCommandCodeRequest(
			MODEL,
			{
				messages: [
					{ role: "user", content: "what time is it" },
					{
						role: "assistant",
						content: "checking",
						tool_calls: [
							{ id: "call_time_1", type: "function", function: { name: "get_time", arguments: "{}" } },
						],
					},
					{ role: "tool", tool_call_id: "call_time_1", content: "12:00 PM" },
				],
			},
			true,
		)

		const block = out.params.messages[2].content[0]
		expect(block.type).toBe("tool-result")
		expect(block.toolName).toBe("get_time")
		expect(block.output).toEqual({ type: "text", value: "12:00 PM" })
	})

	it('falls back to "unknown" when no turn ever declared the call', () => {
		const out = openaiToCommandCodeRequest(
			MODEL,
			{
				messages: [
					{ role: "user", content: "go" },
					{ role: "tool", tool_call_id: "orphan", content: "result" },
				],
			},
			true,
		)
		expect(out.params.messages[1].content[0].toolName).toBe("unknown")
	})

	it('formats a failed execution as an "error-text" output', () => {
		for (const toolMessage of [
			{ role: "tool", tool_call_id: "c1", name: "do_x", content: "boom", is_error: true },
			{ role: "tool", tool_call_id: "c1", name: "do_x", content: "boom", status: "error" },
		]) {
			const out = openaiToCommandCodeRequest(
				MODEL,
				{ messages: [{ role: "user", content: "go" }, toolMessage] },
				true,
			)
			expect(out.params.messages[1].content[0].output).toEqual({ type: "error-text", value: "boom" })
		}
	})
})

describe("openaiToCommandCodeRequest - reasoning blocks", () => {
	it("does not emit a placeholder reasoning block for a tool-call turn", () => {
		const out = openaiToCommandCodeRequest(
			MODEL,
			{
				messages: [
					{ role: "user", content: "go" },
					{
						role: "assistant",
						content: null,
						tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
					},
				],
			},
			true,
		)
		const blocks = out.params.messages[1].content
		expect(blocks.map((b) => b.type)).toEqual(["tool-call"])
	})

	it("keeps real reasoning text as the first block", () => {
		const out = openaiToCommandCodeRequest(
			MODEL,
			{
				messages: [
					{ role: "user", content: "go" },
					{ role: "assistant", reasoning_content: "thinking hard", content: "answer" },
				],
			},
			true,
		)
		expect(out.params.messages[1].content[0]).toEqual({ type: "reasoning", text: "thinking hard" })
	})
})

describe("openaiToCommandCodeRequest - tool input rescue", () => {
	it("keeps unparseable arguments under { raw } instead of dropping them", () => {
		const out = openaiToCommandCodeRequest(
			MODEL,
			{
				messages: [
					{ role: "user", content: "go" },
					{
						role: "assistant",
						content: "",
						tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: '{"a":' } }],
					},
				],
			},
			true,
		)
		const call = out.params.messages[1].content.find((b) => b.type === "tool-call")
		expect(call.input).toEqual({ raw: '{"a":' })
	})

	it("wraps a scalar payload rather than discarding it", () => {
		const out = openaiToCommandCodeRequest(
			MODEL,
			{
				messages: [
					{ role: "user", content: "go" },
					{
						role: "assistant",
						content: "",
						tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: '"str"' } }],
					},
				],
			},
			true,
		)
		expect(out.params.messages[1].content[0].input).toEqual({ value: "str" })
	})

	it("accepts an already-parsed tool_calls[].input", () => {
		const out = openaiToCommandCodeRequest(
			MODEL,
			{
				messages: [
					{ role: "user", content: "go" },
					{
						role: "assistant",
						content: "",
						tool_calls: [{ id: "c1", name: "f", input: { a: 1 } }],
					},
				],
			},
			true,
		)
		const call = out.params.messages[1].content[0]
		expect(call.toolName).toBe("f")
		expect(call.input).toEqual({ a: 1 })
	})
})

describe("openaiToCommandCodeRequest - CLI 1.88.5 envelope slots", () => {
	it("sends null memory/taste/skills with standard permission mode", () => {
		const out = openaiToCommandCodeRequest(
			MODEL,
			{ messages: [{ role: "user", content: "hi" }] },
			true,
		)
		expect(out.memory).toBeNull()
		expect(out.taste).toBeNull()
		expect(out.skills).toBeNull()
		expect(out.permissionMode).toBe("standard")
	})

	it("defaults max_tokens to the CLI's 64000", () => {
		const out = openaiToCommandCodeRequest(
			MODEL,
			{ messages: [{ role: "user", content: "hi" }] },
			true,
		)
		expect(out.params.max_tokens).toBe(64000)
	})

	it("forwards effort from each client shape", () => {
		for (const body of [
			{ reasoning_effort: "high" },
			{ output_config: { effort: "high" } },
			{ reasoning: { effort: "high" } },
		]) {
			const out = openaiToCommandCodeRequest(
				MODEL,
				{ messages: [{ role: "user", content: "hi" }], ...body },
				true,
			)
			expect(out.params.reasoning_effort).toBe("high")
		}
	})

	it("omits reasoning_effort when the client asked for none", () => {
		const out = openaiToCommandCodeRequest(
			MODEL,
			{ messages: [{ role: "user", content: "hi" }] },
			true,
		)
		expect(out.params.reasoning_effort).toBeUndefined()
	})
})

describe("openaiToCommandCodeRequest - tools schema conversion", () => {
	it('converts OpenAI {type:"function", function:{...}} to Anthropic plain {name, input_schema}', () => {
		const out = openaiToCommandCodeRequest(
			MODEL,
			{
				messages: [{ role: "user", content: "hi" }],
				tools: [
					{
						type: "function",
						function: {
							name: "weather",
							description: "Get weather",
							parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
						},
					},
				],
			},
			true,
		)

		const t = out.params.tools[0]
		expect(t.name).toBe("weather")
		expect(t.input_schema).toBeDefined()
		expect(t.input_schema.type).toBe("object")
		expect(t.function).toBeUndefined()
		expect(t.parameters).toBeUndefined()
	})

	it("preserves description on converted tool", () => {
		const out = openaiToCommandCodeRequest(
			MODEL,
			{
				messages: [{ role: "user", content: "hi" }],
				tools: [
					{
						type: "function",
						function: { name: "ping", description: "Ping the server", parameters: { type: "object" } },
					},
				],
			},
			true,
		)
		expect(out.params.tools[0].description).toBe("Ping the server")
	})

	it("does not include tools field when input has none", () => {
		const out = openaiToCommandCodeRequest(
			MODEL,
			{
				messages: [{ role: "user", content: "hi" }],
			},
			true,
		)
		expect(out.params.tools).toBeUndefined()
	})
})

describe("openaiToCommandCodeRequest - native image blocks", () => {
	const PNG_B64 =
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
	const DATA_URI = `data:image/png;base64,${PNG_B64}`

	it("maps OpenAI image_url data URI to CommandCode {type:image,image,mimeType}", () => {
		const out = openaiToCommandCodeRequest(
			MODEL,
			{
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "what color?" },
							{ type: "image_url", image_url: { url: DATA_URI } },
						],
					},
				],
			},
			true,
		)

		expect(out.params.messages[0].content).toEqual([
			{ type: "text", text: "what color?" },
			{ type: "image", image: DATA_URI, mimeType: "image/png" },
		])
	})

	it("maps Claude/OpenAI base64 image source to a data-URI image block", () => {
		const out = openaiToCommandCodeRequest(
			MODEL,
			{
				messages: [
					{
						role: "user",
						content: [
							{
								type: "image",
								source: { type: "base64", media_type: "image/png", data: PNG_B64 },
							},
						],
					},
				],
			},
			true,
		)

		expect(out.params.messages[0].content).toEqual([
			{ type: "image", image: DATA_URI, mimeType: "image/png" },
		])
	})

	it("does not stub dropped images as [image omitted]", () => {
		const out = openaiToCommandCodeRequest(
			MODEL,
			{
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "see this" },
							{ type: "image_url", image_url: { url: DATA_URI } },
						],
					},
				],
			},
			true,
		)

		const texts = out.params.messages[0].content.filter((b) => b.type === "text").map((b) => b.text)
		expect(texts).not.toContain("[image omitted]")
	})
})
