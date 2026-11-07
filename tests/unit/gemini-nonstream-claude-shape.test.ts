/**
 * An Anthropic client calling a Gemini model non-streaming used to receive an
 * OpenAI `chat.completion` body — `object:"chat.completion"`, `choices[]`, and
 * `usage:{}` — because the Gemini branch of translateNonStreamingResponse
 * returned the OpenAI shape unconditionally. Measured on production:
 *
 *   POST /v1/messages {"model":"gemini/gemini-3.5-flash-lite","stream":false}
 *   -> {"id":"chatcmpl-…","object":"chat.completion",…,"usage":{}}
 *
 * An Anthropic SDK sees no `type:"message"` and no `usage`, so the turn reads as
 * a malformed response and the cache read never reaches the client.
 *
 * The same branch also split the usage wrong: thoughts were added to
 * prompt_tokens (output-side tokens billed as input) and
 * cachedContentTokenCount was dropped entirely.
 */
import { describe, expect, it } from "vitest"
import { translateNonStreamingResponse } from "../../apps/web/open-sse/handlers/chatCore/nonStreamingHandler.js"
import { FORMATS } from "../../apps/web/open-sse/translator/formats.js"

const geminiBody = (usageMetadata: Record<string, number>) => ({
	candidates: [
		{
			content: { role: "model", parts: [{ text: "Hi there!" }] },
			finishReason: "STOP",
		},
	],
	usageMetadata,
	modelVersion: "gemini-3.5-flash-lite",
	responseId: "resp-1",
})

describe("a Gemini body translated for an Anthropic client", () => {
	it("comes back as a Claude message, not a chat.completion", () => {
		const out = translateNonStreamingResponse(
			geminiBody({ promptTokenCount: 100, candidatesTokenCount: 10, totalTokenCount: 110 }),
			FORMATS.GEMINI,
			FORMATS.CLAUDE,
		)

		expect(out.type).toBe("message")
		expect(out.role).toBe("assistant")
		expect(out.object).toBeUndefined()
		expect(out.choices).toBeUndefined()
		expect(out.content[0]).toEqual({ type: "text", text: "Hi there!" })
	})

	it("carries the cache read through as cache_read_input_tokens", () => {
		const out = translateNonStreamingResponse(
			geminiBody({
				promptTokenCount: 5344,
				cachedContentTokenCount: 5332,
				candidatesTokenCount: 12,
				totalTokenCount: 5356,
			}),
			FORMATS.GEMINI,
			FORMATS.CLAUDE,
		)

		expect(out.usage.cache_read_input_tokens).toBe(5332)
		// input_tokens is the uncached remainder, as Anthropic reports it.
		expect(out.usage.input_tokens).toBe(12)
		expect(out.usage.output_tokens).toBe(12)
	})

	it("counts thoughts as output, not input", () => {
		const out = translateNonStreamingResponse(
			geminiBody({
				promptTokenCount: 100,
				candidatesTokenCount: 10,
				thoughtsTokenCount: 40,
				totalTokenCount: 150,
			}),
			FORMATS.GEMINI,
			FORMATS.CLAUDE,
		)

		expect(out.usage.input_tokens).toBe(100)
		expect(out.usage.output_tokens).toBe(50)
	})

	it("still returns the OpenAI shape for an OpenAI client", () => {
		const out = translateNonStreamingResponse(
			geminiBody({ promptTokenCount: 100, candidatesTokenCount: 10, totalTokenCount: 110 }),
			FORMATS.GEMINI,
			FORMATS.OPENAI,
		)

		expect(out.object).toBe("chat.completion")
		expect(out.choices[0].message.content).toBe("Hi there!")
		expect(out.usage.prompt_tokens).toBe(100)
	})

	it("keeps tool calls when converting to Claude", () => {
		const body = {
			candidates: [
				{
					content: {
						role: "model",
						parts: [{ functionCall: { name: "get_weather", args: { city: "Jakarta" } } }],
					},
					finishReason: "STOP",
				},
			],
			usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
			modelVersion: "gemini-3.5-flash-lite",
		}
		const out = translateNonStreamingResponse(body, FORMATS.GEMINI, FORMATS.CLAUDE)

		const toolUse = out.content.find((b: any) => b.type === "tool_use")
		expect(toolUse.name).toBe("get_weather")
		expect(toolUse.input).toEqual({ city: "Jakarta" })
		expect(out.stop_reason).toBe("tool_use")
	})
})
