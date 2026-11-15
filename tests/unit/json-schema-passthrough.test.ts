// `response_format: json_schema` on an openai-compatible node.
//
// The combo layer forwards the request body to every member untouched, so it is
// not what loses the schema. The loss happens here: DefaultExecutor downgrades
// json_schema to json_object and moves the schema into the system prompt, which
// keeps the call alive on an endpoint nobody has probed but hands back no
// guarantee - the model may still answer with prose or fences, and only a
// downstream repair (JSON Guard, or the caller's own parser) makes it usable.
//
// `supportsJsonSchema` on the node is the opt-out: the request keeps the schema
// it asked for, so the upstream constrains generation itself. Opt-in only,
// because sending the field to an endpoint that does not implement it is a 400.
import { DefaultExecutor } from "open-sse/executors/default.js"
import { describe, expect, it } from "vitest"

const provider = "openai-compatible-chat-structured"
const model = "facts-model"
const schema = {
	type: "object",
	properties: { facts: { type: "array", items: { type: "string" } } },
	required: ["facts"],
	additionalProperties: false,
}

const body = () => ({
	model,
	messages: [{ role: "user", content: "extract the facts" }],
	response_format: {
		type: "json_schema",
		json_schema: { name: "facts", strict: true, schema },
	},
})

function credentials(providerSpecificData: Record<string, unknown> = {}) {
	return { apiKey: "sk-test", providerSpecificData: { apiType: "chat", ...providerSpecificData } }
}

describe("response_format: json_schema on an openai-compatible node", () => {
	it("downgrades to json_object and moves the schema into the prompt by default", () => {
		const original = body()
		const transformed = new DefaultExecutor(provider).transformRequest(
			model,
			original,
			false,
			credentials(),
		)

		expect(transformed.response_format).toEqual({ type: "json_object" })
		const system = transformed.messages.find(
			(message: { role?: string; content?: unknown }) => message.role === "system",
		)
		expect(system?.content).toContain(JSON.stringify(schema, null, 2))

		// The caller's body survives untouched: the same request is retried against
		// the next combo member, which may have different capabilities.
		expect(original.response_format.type).toBe("json_schema")
		expect(original.messages).toHaveLength(1)
	})

	it("keeps the schema the client asked for when the node opted in", () => {
		const transformed = new DefaultExecutor(provider).transformRequest(
			model,
			body(),
			false,
			credentials({ supportsJsonSchema: true }),
		)

		expect(transformed.response_format).toEqual(body().response_format)
		// Nothing was appended to the prompt: the schema is enforced upstream, so
		// repeating it in prose only spends tokens.
		expect(transformed.messages).toHaveLength(1)
		expect(transformed.messages[0].content).toBe("extract the facts")
	})

	it("still downgrades when the flag is explicitly off", () => {
		const transformed = new DefaultExecutor(provider).transformRequest(
			model,
			body(),
			false,
			credentials({ supportsJsonSchema: false }),
		)

		expect(transformed.response_format).toEqual({ type: "json_object" })
	})

	it("leaves json_object alone whether or not the node opted in", () => {
		for (const supportsJsonSchema of [false, true]) {
			const original = {
				model,
				messages: [{ role: "user", content: "hi" }],
				response_format: { type: "json_object" },
			}
			const transformed = new DefaultExecutor(provider).transformRequest(
				model,
				original,
				false,
				credentials({ supportsJsonSchema }),
			)

			expect(transformed.response_format).toEqual({ type: "json_object" })
			expect(transformed.messages).toHaveLength(1)
		}
	})

	it("leaves a native provider's schema alone", () => {
		// Only compatible nodes are downgraded; a first-class provider speaks a
		// format this fallback has no business rewriting.
		const transformed = new DefaultExecutor("openai").transformRequest(
			model,
			body(),
			false,
			credentials({ supportsJsonSchema: false }),
		)

		expect(transformed.response_format).toEqual(body().response_format)
		expect(transformed.messages).toHaveLength(1)
	})
})
