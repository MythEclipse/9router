import { afterEach, describe, expect, it, vi } from "vitest"
import { PROVIDER_MODELS } from "../../apps/web/open-sse/config/providerModels.js"
import { pickDecisionReviewTarget } from "../../apps/web/open-sse/handlers/safeguardsReview.js"
import {
	buildSystemoneAuthHeaders,
	buildSystemoneUrl,
	handleSystemoneCore,
	readSystemoneState,
	systemoneStateField,
} from "../../apps/web/open-sse/handlers/systemoneCore.js"
import { PROVIDER_MEDIA } from "../../apps/web/open-sse/providers/index.js"
import REGISTRY from "../../apps/web/open-sse/providers/registry/index.js"
import { getProvidersByKind } from "../../apps/web/src/shared/constants/providers.js"

const GOOGLE_URL = "https://generativelanguage.googleapis.com/v1beta/decisions"
const cfg = PROVIDER_MEDIA.gemini?.systemoneConfig

describe("Gemini System One (decisions) lane", () => {
	const entry = REGISTRY.find((candidate) => candidate.id === "gemini")

	it("rides on the gemini provider instead of a second credential", () => {
		// The whole point: one Gemini connection serves chat, embeddings and decisions.
		expect(entry).toBeDefined()
		expect(entry.serviceKinds).toContain("systemone")
		expect(entry.serviceKinds).toContain("llm")
		expect(entry.serviceKinds).toContain("embedding")
		expect(cfg?.baseUrl).toBe(GOOGLE_URL)
		expect(cfg?.path).toBe("/v1beta/decisions")
	})

	it("declares the two wire differences from the other lanes", () => {
		// Google rejects an API key in Authorization and calls the state `input`.
		expect(cfg?.authHeader).toBe("x-goog-api-key")
		expect(cfg?.stateField).toBe("input")
	})

	it("appears in getProvidersByKind('systemone') as gemini", () => {
		const found = getProvidersByKind("systemone").find((provider) => provider.id === "gemini")
		expect(found).toBeDefined()
		expect(found.systemoneConfig?.baseUrl).toBe(GOOGLE_URL)
	})

	it("resolves gemini/gemini-decision-1 through the gemini model list", () => {
		const decision = PROVIDER_MODELS.gemini.find((model) => model.id === "gemini-decision-1")
		expect(decision).toBeDefined()
		expect(decision.kind).toBe("systemone")
	})

	it("does not displace the existing safeguards reviewer", () => {
		// pickDecisionReviewTarget prefers the lowest priority; attaching a keyed lane to a
		// chat provider must not take over reviews from the free decision lanes.
		const target = pickDecisionReviewTarget({}, null)
		expect(target?.provider).not.toBe("gemini")
		expect(entry.priority).toBeGreaterThan(30)
	})

	it.each([
		[undefined, GOOGLE_URL],
		["https://gateway.example", "https://gateway.example/v1beta/decisions"],
		["https://gateway.example/v1beta/", "https://gateway.example/v1beta/decisions"],
		["https://gateway.example/v1beta/decisions", "https://gateway.example/v1beta/decisions"],
	])("joins a saved host %s with the registry path", (host, expected) => {
		expect(buildSystemoneUrl(host, cfg)).toBe(expected)
	})
})

describe("System One state field and auth helpers", () => {
	it("reads the canonical state name", () => {
		expect(readSystemoneState({ state: "ticket text" })).toBe("ticket text")
	})

	it("reads the Google name too, so one body works on every lane", () => {
		expect(readSystemoneState({ input: "ticket text" })).toBe("ticket text")
		expect(readSystemoneState({ state: "a", input: "b" })).toBe("a")
	})

	it("unwraps a shorthand state object", () => {
		expect(readSystemoneState({ state: { prompt: "from prompt" } })).toBe("from prompt")
		expect(readSystemoneState({ state: { text: "from text" } })).toBe("from text")
	})

	it("returns undefined when no state is present", () => {
		expect(readSystemoneState({})).toBeUndefined()
		expect(readSystemoneState({ state: null })).toBeUndefined()
		expect(readSystemoneState(undefined)).toBeUndefined()
	})

	it("defaults the wire field to state", () => {
		expect(systemoneStateField(undefined)).toBe("state")
		expect(systemoneStateField({})).toBe("state")
		expect(systemoneStateField({ stateField: "  " })).toBe("state")
		expect(systemoneStateField({ stateField: "input" })).toBe("input")
	})

	it("sends Bearer unless the lane names its own header", () => {
		expect(buildSystemoneAuthHeaders(undefined, "k")).toEqual({ Authorization: "Bearer k" })
		expect(buildSystemoneAuthHeaders({ authHeader: "bearer" }, "k")).toEqual({
			Authorization: "Bearer k",
		})
		expect(buildSystemoneAuthHeaders({ authHeader: "key" }, "k")).toEqual({
			Authorization: "Bearer k",
		})
		expect(buildSystemoneAuthHeaders({ authHeader: "x-goog-api-key" }, "k")).toEqual({
			"x-goog-api-key": "k",
		})
		expect(buildSystemoneAuthHeaders(cfg, undefined)).toEqual({})
	})
})

describe("handleSystemoneCore for the gemini decisions lane", () => {
	afterEach(() => vi.unstubAllGlobals())

	// The lane forwards the JSON reply untouched, so the fixture is the protocol shape
	// (answers + usage) that nace/ollama/opencode also answer with.
	const upstreamReply = {
		model: "gemini-decision-1",
		answers: {
			is_damaged: { type: "noul", noul: 0.94 },
			queue: {
				type: "choice",
				choice: "replacements",
				confidence: 0.91,
				probabilities: { billing: 0.02, replacements: 0.91, general: 0.07 },
			},
		},
		usage: { input_tokens: 128, output_tokens: 32 },
	}

	const questions = {
		is_damaged: { type: "noul", instructions: "Did the item arrive damaged?" },
		queue: {
			type: "choice",
			instructions: "Which support queue should handle this message?",
			criteria: {
				billing: "Payment, invoice, or refund questions.",
				replacements: "Damaged, missing, or wrong items.",
				general: "Product questions and account updates.",
			},
		},
	}

	async function call(
		body,
		credentials = { apiKey: "gemini_connection_key" },
		model = "gemini-decision-1",
	) {
		const fetchMock = vi.fn(async () => new Response(JSON.stringify(upstreamReply), { status: 200 }))
		vi.stubGlobal("fetch", fetchMock)
		const result = await handleSystemoneCore({
			body,
			modelInfo: { provider: "gemini", model },
			credentials,
		})
		const callArgs = fetchMock.mock.calls[0]
		return {
			result,
			url: callArgs?.[0],
			headers: callArgs?.[1]?.headers,
			sent: callArgs ? JSON.parse(callArgs[1].body) : null,
		}
	}

	it("posts to the decisions endpoint with the connection key in x-goog-api-key", async () => {
		const r = await call({ state: "The blue mug arrived cracked.", questions })
		expect(r.result.success).toBe(true)
		expect(r.url).toBe(GOOGLE_URL)
		// Same key as chat and embeddings: there is no second credential to enter.
		expect(r.headers["x-goog-api-key"]).toBe("gemini_connection_key")
		expect(r.headers.Authorization).toBeUndefined()
		expect(r.headers["Content-Type"]).toBe("application/json")
		expect(r.headers["x-opencode-session"]).toBeUndefined()
	})

	it("renames state to input and never sends both", async () => {
		const r = await call({ state: "The blue mug arrived cracked.", questions })
		expect(r.sent.input).toBe("The blue mug arrived cracked.")
		expect(r.sent.state).toBeUndefined()
		expect(r.sent.model).toBe("gemini-decision-1")
		expect(r.sent.questions).toEqual(questions)
	})

	it("accepts a Google-shaped body (input instead of state)", async () => {
		const r = await call({ input: "The blue mug arrived cracked.", questions })
		expect(r.result.success).toBe(true)
		expect(r.sent.input).toBe("The blue mug arrived cracked.")
		expect(r.sent.state).toBeUndefined()
	})

	it("normalizes shorthand string questions to noul", async () => {
		const r = await call({ state: "text", questions: { is_urgent: "Is this urgent?" } })
		expect(r.sent.questions).toEqual({
			is_urgent: { type: "noul", instructions: "Is this urgent?" },
		})
	})

	it("forwards the reply unchanged and maps usage", async () => {
		const r = await call({ state: "text", questions })
		expect(await r.result.response.json()).toEqual(upstreamReply)
		expect(r.result.usage).toEqual({ prompt_tokens: 128, completion_tokens: 32 })
	})

	it("rejects a body with neither state nor input", async () => {
		const r = await call({ questions })
		expect(r.result.success).toBe(false)
		expect(r.result.status).toBe(400)
		expect(r.result.error).toBe("Missing required field: state")
		expect(r.url).toBeUndefined()
	})

	it("rejects a body without questions", async () => {
		const r = await call({ state: "text" })
		expect(r.result.success).toBe(false)
		expect(r.result.status).toBe(400)
		expect(r.result.error).toBe("Missing required field: questions")
	})

	it("keeps Bearer auth and the state name on lanes that declare neither", async () => {
		// Regression guard: the Google lane must not leak its wire shape into nace.
		const fetchMock = vi.fn(async () => new Response(JSON.stringify(upstreamReply), { status: 200 }))
		vi.stubGlobal("fetch", fetchMock)
		await handleSystemoneCore({
			body: { state: "text", questions },
			modelInfo: { provider: "nace", model: "drex-max" },
			credentials: { apiKey: "nace_sk_test" },
		})
		const [, init] = fetchMock.mock.calls[0]
		expect(init.headers.Authorization).toBe("Bearer nace_sk_test")
		expect(init.headers["x-goog-api-key"]).toBeUndefined()
		const sent = JSON.parse(init.body)
		expect(sent.state).toBe("text")
		expect(sent.input).toBeUndefined()
	})
})
