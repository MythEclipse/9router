/**
 * A model that serialises a nested parameter — `{"questions":"[{…}]"}` — still
 * produced the right call; only its JSON shape is wrong. A client validating
 * against the schema it declared rejects it:
 *
 *   InputValidationError: The parameter `questions` type is expected as `array`
 *   but provided as `string`
 *
 * Claude Code answers a rejected tool call by retrying it, and the model copies
 * the shape it just produced, so one stringified parameter becomes a turn that
 * loops forever with no gateway-side error to show for it (the response is a
 * clean 200; the rejection happens in the client).
 *
 * The schema is the only safe authority here: a `content` parameter that holds
 * JSON *text* must stay a string, and only the declaration can tell the two
 * apart.
 */
import { describe, expect, it } from "vitest"
import {
	coerceDeclaredTypes,
	repairToolArguments,
	rescueToolCall,
} from "../../apps/web/open-sse/translator/concerns/toolCallRescue.js"

const askUserQuestion = {
	name: "AskUserQuestion",
	input_schema: {
		type: "object",
		properties: {
			questions: {
				type: "array",
				maxItems: 4,
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
	},
}

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

describe("coerceDeclaredTypes", () => {
	it("un-stringifies an array the schema declares", () => {
		const input = { questions: JSON.stringify(questions) }
		const out = coerceDeclaredTypes(input, askUserQuestion.input_schema)
		expect(Array.isArray(out.questions)).toBe(true)
		expect(out.questions).toEqual(questions)
	})

	it("reaches into array items", () => {
		const input = {
			questions: [{ ...questions[0], options: JSON.stringify(questions[0].options) }],
		}
		const out = coerceDeclaredTypes(input, askUserQuestion.input_schema)
		expect(Array.isArray(out.questions[0].options)).toBe(true)
		expect(out.questions[0].options).toHaveLength(2)
	})

	it("leaves a string parameter holding JSON text alone", () => {
		const schema = { type: "object", properties: { content: { type: "string" } } }
		const input = { content: '{"a":1}' }
		expect(coerceDeclaredTypes(input, schema).content).toBe('{"a":1}')
	})

	it("leaves a string alone when it does not parse to the declared type", () => {
		const input = { questions: "not json at all" }
		expect(coerceDeclaredTypes(input, askUserQuestion.input_schema).questions).toBe("not json at all")
	})

	it("does not turn a JSON object into a declared array", () => {
		const input = { questions: '{"a":1}' }
		expect(coerceDeclaredTypes(input, askUserQuestion.input_schema).questions).toBe('{"a":1}')
	})

	it("returns the same object when nothing needed changing", () => {
		const input = { questions }
		expect(coerceDeclaredTypes(input, askUserQuestion.input_schema)).toBe(input)
	})

	it("survives a missing schema", () => {
		const input = { questions: JSON.stringify(questions) }
		expect(coerceDeclaredTypes(input, null)).toBe(input)
	})
})

describe("repairToolArguments", () => {
	it("rewrites the buffered arguments with the array restored", () => {
		const raw = JSON.stringify({ questions: JSON.stringify(questions) })
		const repaired = repairToolArguments(raw, askUserQuestion.input_schema)
		expect(Array.isArray(JSON.parse(repaired).questions)).toBe(true)
	})

	it("returns the original string untouched when there is nothing to fix", () => {
		const raw = JSON.stringify({ questions })
		expect(repairToolArguments(raw, askUserQuestion.input_schema)).toBe(raw)
	})

	it("fails open on unparseable arguments", () => {
		expect(repairToolArguments('{"questions":', askUserQuestion.input_schema)).toBe('{"questions":')
	})
})

describe("rescueToolCall", () => {
	const index = new Map([
		["askuserquestion", { name: "AskUserQuestion", schema: askUserQuestion.input_schema }],
	])

	it("coerces the stringified parameter for a Claude-shaped block", () => {
		const out = rescueToolCall(
			{ name: "AskUserQuestion", arguments: { questions: JSON.stringify(questions) } },
			index,
		)
		expect(out.call).not.toBeNull()
		expect(Array.isArray(JSON.parse(out.call.arguments).questions)).toBe(true)
	})

	it("coerces the stringified parameter for an OpenAI-shaped call", () => {
		const out = rescueToolCall(
			{
				id: "call_1",
				function: {
					name: "AskUserQuestion",
					arguments: JSON.stringify({ questions: JSON.stringify(questions) }),
				},
			},
			index,
		)
		expect(Array.isArray(JSON.parse(out.call.function.arguments).questions)).toBe(true)
	})
})
