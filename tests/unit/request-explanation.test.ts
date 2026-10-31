/**
 * Request explanation: what the log can prove, and what it must admit it cannot.
 *
 * The failure this prevents is an explanation that reads as complete — naming a router branch it
 * never recorded, or reporting `$0` for a request nobody priced.
 */

import { type ExplainPorts, makeExplain } from "9router-api/application/requests/explain"
import {
	type ExplainedDetail,
	explainRequest,
	fieldChanges,
	latencyOf,
	tokensOf,
} from "9router-api/domain/request-explanation"
import { describe, expect, it } from "vitest"

const detail = (over: Partial<ExplainedDetail> = {}): ExplainedDetail => ({
	id: "req_1",
	provider: "claude",
	model: "claude-3-5-sonnet",
	resolvedModel: "claude-3-5-sonnet",
	connectionId: "conn_9",
	status: 200,
	latency: { total: 1200 },
	tokens: { prompt_tokens: 1000, completion_tokens: 500 },
	request: { model: "claude-3-5-sonnet", messages: [{ role: "user", content: "hi" }], stream: true },
	providerRequest: { model: "claude-3-5-sonnet", system: "", messages: [] },
	...over,
})

describe("fieldChanges", () => {
	it("names a field the translator added", () => {
		const changes = fieldChanges({ model: "m" }, { model: "m", system: "" })

		expect(changes).toEqual([{ field: "system", change: "added", to: "" }])
	})

	it("names a field the translator dropped", () => {
		const changes = fieldChanges({ model: "m", stream: true }, { model: "m" })

		expect(changes).toEqual([{ field: "stream", change: "removed", from: "true" }])
	})

	it("names a field whose value changed, with both sides", () => {
		const [change] = fieldChanges({ model: "gpt-4o" }, { model: "gpt-4o-2024" })

		expect(change).toMatchObject({
			field: "model",
			change: "changed",
			from: "gpt-4o",
			to: "gpt-4o-2024",
		})
	})

	it("reports nothing when the body was forwarded unchanged", () => {
		expect(fieldChanges({ a: 1 }, { a: 1 })).toEqual([])
	})

	it("answers nothing for a body that is not an object", () => {
		expect(fieldChanges(null, { a: 1 })).toEqual([])
	})

	it("summarises an array rather than dumping it into the report", () => {
		const [change] = fieldChanges({ messages: [{ role: "user" }] }, { messages: [] })

		expect(change?.from).toBe("[1 item]")
		expect(change?.to).toBe("[0 items]")
	})
})

describe("tokensOf", () => {
	it("keeps the numbers and drops the junk", () => {
		expect(tokensOf({ tokens: { prompt_tokens: 10, junk: "x", bad: Number.NaN, neg: -1 } })).toEqual({
			prompt_tokens: 10,
		})
	})
})

describe("latencyOf", () => {
	it("finds the total under any of the names the log has used", () => {
		expect(latencyOf({ latency: { totalMs: 90 } })).toBe(90)
		expect(latencyOf({ latency: { total: 120 } })).toBe(120)
	})

	it("answers null when no latency was recorded", () => {
		expect(latencyOf({ latency: {} })).toBeNull()
		expect(latencyOf({})).toBeNull()
	})
})

describe("explainRequest", () => {
	it("walks the pipeline in order", () => {
		const explanation = explainRequest(detail())

		expect(explanation.steps.map((step) => step.step)).toEqual([
			"received",
			"translated",
			"routed",
			"answered",
		])
	})

	it("says the body was forwarded unchanged when there is no diff", () => {
		const explanation = explainRequest(
			detail({ request: { model: "m" }, providerRequest: { model: "m" } }),
		)

		expect(explanation.steps[1]?.detail).toBe("the body was forwarded unchanged")
	})

	it("admits that the router's alternatives are not recorded", () => {
		const explanation = explainRequest(detail())

		expect(explanation.unknown.join(" ")).toMatch(/considered/)
	})

	it("admits a model resolution it cannot justify", () => {
		const explanation = explainRequest(detail({ model: "auto", resolvedModel: "claude-3-5-sonnet" }))

		expect(explanation.unknown.join(" ")).toMatch(/resolved to/)
	})

	it("admits a missing provider request instead of inventing a translation", () => {
		const explanation = explainRequest(detail({ providerRequest: undefined }))

		expect(explanation.changes).toEqual([])
		expect(explanation.unknown.join(" ")).toMatch(/cannot be shown/)
	})

	it("carries the cost it was given, and null when it was given none", () => {
		expect(explainRequest(detail(), 0.42).costUsd).toBe(0.42)
		expect(explainRequest(detail()).costUsd).toBeNull()
	})
})

function ports(over: Partial<ExplainPorts> = {}): ExplainPorts {
	return {
		byId: async (id) => (id === "req_1" ? detail() : null),
		ratesOf: () => ({ input: 3, output: 15 }),
		...over,
	}
}

describe("makeExplain", () => {
	it("prices the request from the recorded tokens and the model's rates", async () => {
		const explanation = await makeExplain(ports()).explain("req_1")

		// 1000 in at $3/M + 500 out at $15/M
		expect(explanation.costUsd).toBeCloseTo(0.0105, 10)
	})

	it("answers null cost rather than zero for an unpriced model", async () => {
		const explanation = await makeExplain(ports({ ratesOf: () => null })).explain("req_1")

		expect(explanation.costUsd).toBeNull()
	})

	it("answers null cost when no tokens were recorded", async () => {
		const explanation = await makeExplain(
			ports({ byId: async () => detail({ tokens: {} }) }),
		).explain("req_1")

		expect(explanation.costUsd).toBeNull()
	})

	it("answers 404 for a request that has aged out of the log", async () => {
		await expect(makeExplain(ports()).explain("req_gone")).rejects.toMatchObject({
			code: "NOT_FOUND",
		})
	})
})
