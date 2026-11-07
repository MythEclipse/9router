/**
 * A gateway that builds its non-streaming completion by dumping the delta
 * sequence into `message.tool_calls` sends one id-bearing entry followed by a
 * run of argument fragments. Verified live against ai.mikulab.cloud
 * (gpt-6-luna): a single `get_weather` call arrives as eight entries.
 *
 * Forwarded as-is, a Claude client gets one `tool_use` per fragment, each with
 * `name:""` and `input:{}` — a turn the client cannot act on.
 */
import { describe, expect, it } from "vitest"
import { mergeFragmentedToolCalls } from "../../apps/web/open-sse/utils/toolCallRepair.js"

const body = (toolCalls: unknown[]) => ({
	choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: toolCalls } }],
})

const callsOf = (document: any) => document.choices[0].message.tool_calls

describe("mergeFragmentedToolCalls", () => {
	it("folds the live mikulab fragment sequence back into one call", () => {
		const document = body([
			{
				function: { arguments: "{}", name: "get_weather" },
				id: "call_00_x",
				index: 0,
				type: "function",
			},
			{ function: { arguments: '{"' }, index: 0 },
			{ function: { arguments: "city" }, index: 0 },
			{ function: { arguments: '": "' }, index: 0 },
			{ function: { arguments: "Jakarta" }, index: 0 },
			{ function: { arguments: '"}' }, index: 0 },
		])

		expect(mergeFragmentedToolCalls(document)).toBe(5)
		expect(callsOf(document)).toHaveLength(1)
		expect(callsOf(document)[0].id).toBe("call_00_x")
		expect(callsOf(document)[0].function.name).toBe("get_weather")
		expect(JSON.parse(callsOf(document)[0].function.arguments)).toEqual({ city: "Jakarta" })
	})

	it("keeps genuine parallel calls, which each carry their own id", () => {
		const document = body([
			{ id: "call_a", type: "function", function: { name: "f", arguments: '{"a":1}' } },
			{ id: "call_b", type: "function", function: { name: "g", arguments: '{"b":2}' } },
		])

		expect(mergeFragmentedToolCalls(document)).toBe(0)
		expect(callsOf(document)).toHaveLength(2)
	})

	it("leaves a single well-formed call untouched", () => {
		const document = body([
			{ id: "call_a", type: "function", function: { name: "f", arguments: '{"a":1}' } },
		])

		expect(mergeFragmentedToolCalls(document)).toBe(0)
		expect(callsOf(document)[0].function.arguments).toBe('{"a":1}')
	})

	it("starts from empty rather than concatenating onto an empty-args placeholder", () => {
		const document = body([
			{ id: "call_a", type: "function", function: { name: "f", arguments: "" } },
			{ function: { arguments: '{"a"' } },
			{ function: { arguments: ":1}" } },
		])

		mergeFragmentedToolCalls(document)
		expect(callsOf(document)[0].function.arguments).toBe('{"a":1}')
	})

	it("leaves a Claude-native body alone", () => {
		const document = {
			type: "message",
			content: [{ type: "tool_use", id: "toolu_1", name: "f", input: { a: 1 } }],
		}

		expect(mergeFragmentedToolCalls(document)).toBe(0)
		expect(document.content).toHaveLength(1)
	})

	it.each([null, undefined, {}, { choices: null }, { choices: [{}] }, "text", 42])(
		"fails open on a body it cannot read: %j",
		(input) => {
			expect(mergeFragmentedToolCalls(input)).toBe(0)
		},
	)
})
