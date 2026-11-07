/**
 * End-to-end: a Kiro/OpenAI-shaped upstream serialises AskUserQuestion's
 * `questions` array as a string, and the Claude client must receive an array.
 *
 * Both response translators buffer tool arguments before emitting them, so the
 * repair happens where the whole call is finally known — `sanitizeToolArgs` on
 * the openai→claude route and `repairToolArguments` on the direct kiro→claude
 * route. This exercises the translators themselves rather than the helper, so a
 * future refactor that drops the schema wiring fails here.
 *
 * Note the argument order: translateResponse(targetFormat, sourceFormat, …)
 * names the upstream format first and the client format second.
 */
import { describe, expect, it } from "vitest"
import "../translator/registerAll.js"
import { FORMATS } from "../../apps/web/open-sse/translator/formats.js"
import { initState, translateResponse } from "../../apps/web/open-sse/translator/index.js"

const questions = [
	{
		question: "Which database?",
		header: "Database",
		options: [
			{ label: "Postgres", description: "Rich features" },
			{ label: "MySQL", description: "Simple setup" },
		],
		multiSelect: false,
	},
]

const inputSchema = {
	type: "object",
	properties: {
		questions: {
			type: "array",
			items: {
				type: "object",
				properties: {
					question: { type: "string" },
					header: { type: "string" },
					options: {
						type: "array",
						items: {
							type: "object",
							properties: { label: { type: "string" }, description: { type: "string" } },
						},
					},
					multiSelect: { type: "boolean" },
				},
			},
		},
	},
	required: ["questions"],
}

// The model stringified the array instead of inlining it.
const stringifiedArgs = JSON.stringify({ questions: JSON.stringify(questions) })

const toolChunk = (args: string) => ({
	id: "chatcmpl-test",
	object: "chat.completion.chunk",
	created: 1,
	model: "test",
	choices: [
		{
			index: 0,
			delta: {
				tool_calls: [
					{
						index: 0,
						id: "toolu_1",
						type: "function",
						function: { name: "AskUserQuestion", arguments: args },
					},
				],
			},
			finish_reason: null,
		},
	],
})

const finishChunk = {
	id: "chatcmpl-test",
	object: "chat.completion.chunk",
	created: 1,
	model: "test",
	choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
}

function runRoute(upstreamFormat: string, clientFormat: string) {
	const state = {
		...initState(clientFormat),
		toolSchemas: new Map([["askuserquestion", { name: "AskUserQuestion", schema: inputSchema }]]),
	}
	const events: any[] = []
	for (const chunk of [toolChunk(stringifiedArgs), finishChunk]) {
		const out = translateResponse(upstreamFormat, clientFormat, chunk, state)
		if (out) events.push(...(Array.isArray(out) ? out : [out]))
	}

	const partial = events
		.filter((e) => e?.delta?.type === "input_json_delta")
		.map((e) => e.delta.partial_json)
		.join("")
	return { events, input: partial ? JSON.parse(partial) : null }
}

describe("a stringified tool parameter from the model", () => {
	it("reaches an Anthropic client as an array", () => {
		const { events, input } = runRoute(FORMATS.OPENAI, FORMATS.CLAUDE)

		const start = events.find((e) => e?.content_block?.type === "tool_use")
		expect(start?.content_block?.name).toBe("AskUserQuestion")
		expect(input).not.toBeNull()
		expect(Array.isArray(input.questions)).toBe(true)
		expect(input.questions).toEqual(questions)
	})

	it("still opens exactly one tool_use block", () => {
		const { events } = runRoute(FORMATS.OPENAI, FORMATS.CLAUDE)
		expect(events.filter((e) => e?.content_block?.type === "tool_use")).toHaveLength(1)
		expect(events.filter((e) => e?.type === "content_block_stop")).toHaveLength(1)
	})

	it("does not touch the arguments on the OpenAI route", () => {
		// An OpenAI client receives the upstream chunk as-is; the schema repair is a
		// Claude-route concern, so nothing may rewrite the caller's own payload.
		const { events } = runRoute(FORMATS.OPENAI, FORMATS.OPENAI)
		const args = events[0]?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments
		expect(args).toBe(stringifiedArgs)
	})

	it("is repaired on the direct kiro→claude route too", () => {
		// Kiro's executor already emits OpenAI-shaped chunks, and the direct route
		// buffers and emits them itself — a separate code path from openai→claude,
		// so it needs its own proof.
		const { input } = runRoute(FORMATS.KIRO, FORMATS.CLAUDE)
		expect(input).not.toBeNull()
		expect(Array.isArray(input.questions)).toBe(true)
		expect(input.questions).toEqual(questions)
	})
})
