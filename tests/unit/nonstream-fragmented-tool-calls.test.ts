import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/usageDb.js", () => ({
	appendRequestLog: vi.fn(async () => {}),
	saveRequestDetail: vi.fn(async () => {}),
	saveRequestUsage: vi.fn(async () => {}),
}))

import { handleNonStreamingResponse } from "../../apps/web/open-sse/handlers/chatCore/nonStreamingHandler.js"
import { FORMATS } from "../../apps/web/open-sse/translator/formats.js"

beforeEach(() => vi.clearAllMocks())

const TOOLS = [
	{
		type: "function",
		function: {
			name: "get_weather",
			parameters: { type: "object", properties: { city: { type: "string" } } },
		},
	},
]

/**
 * The exact shape ai.mikulab.cloud returns for a non-streaming tool call
 * (captured live 2026-11-07): the delta sequence dumped into `tool_calls`,
 * one id-bearing entry then a run of argument fragments.
 */
const fragmented = {
	id: "chatcmpl-test",
	object: "chat.completion",
	created: 1794045806,
	model: "gpt-6-luna",
	choices: [
		{
			index: 0,
			finish_reason: "tool_calls",
			message: {
				role: "assistant",
				content: "",
				tool_calls: [
					{
						id: "call_00_x",
						index: 0,
						type: "function",
						function: { name: "get_weather", arguments: "" },
					},
					{ index: 0, function: { arguments: '{"' } },
					{ index: 0, function: { arguments: "city" } },
					{ index: 0, function: { arguments: '": "' } },
					{ index: 0, function: { arguments: "Jakarta" } },
					{ index: 0, function: { arguments: '"}' } },
				],
			},
		},
	],
	usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
}

function context(sourceFormat: string): any {
	return {
		providerResponse: new Response(JSON.stringify(fragmented), {
			headers: { "content-type": "application/json" },
		}),
		provider: "openai-compatible-56bc3a55-c19f-49c7-954a-0fdbe98ef891",
		model: "gpt-6-luna",
		sourceFormat,
		targetFormat: FORMATS.OPENAI,
		body: { model: "miku/gpt-6-luna", stream: false, tools: TOOLS, messages: [] },
		translatedBody: { model: "gpt-6-luna", stream: false, tools: TOOLS, messages: [] },
		stream: false,
		requestStartTime: Date.now(),
		connectionId: "test-connection",
		clientRawRequest: { endpoint: "/v1/messages" },
		onRequestSuccess: vi.fn(),
		trackDone: vi.fn(),
		appendLog: vi.fn(),
		reqLogger: { logProviderResponse: vi.fn(), logConvertedResponse: vi.fn() },
		log: { line: vi.fn(), debug: vi.fn() },
	}
}

describe("a fragmented tool_calls body from an [OI] upstream", () => {
	it("reaches a Claude client as one tool_use with the real name and input", async () => {
		const ctx = context(FORMATS.CLAUDE)
		const result = await handleNonStreamingResponse(ctx)
		const json = await result.response.json()

		expect(result.success).toBe(true)
		expect(result.response.status).toBe(200)
		const toolUses = json.content.filter((block: any) => block.type === "tool_use")
		expect(toolUses).toHaveLength(1)
		expect(toolUses[0].name).toBe("get_weather")
		expect(toolUses[0].input).toEqual({ city: "Jakarta" })
		expect(json.stop_reason).toBe("tool_use")
	})

	it("reaches an [OI] client as one tool call", async () => {
		const ctx = context(FORMATS.OPENAI)
		const result = await handleNonStreamingResponse(ctx)
		const json = await result.response.json()

		const calls = json.choices[0].message.tool_calls
		expect(calls).toHaveLength(1)
		expect(calls[0].function.name).toBe("get_weather")
		expect(JSON.parse(calls[0].function.arguments)).toEqual({ city: "Jakarta" })
	})
})
