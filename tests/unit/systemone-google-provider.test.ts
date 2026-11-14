import { afterEach, describe, expect, it, vi } from "vitest"
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
const cfg = PROVIDER_MEDIA.systemone?.systemoneConfig

describe("System One (Google) provider", () => {
	const entry = REGISTRY.find((candidate) => candidate.id === "systemone")

	it("is registered as a System One apikey provider", () => {
		expect(entry).toBeDefined()
		expect(entry.category).toBe("apikey")
		expect(entry.authType).toBe("apikey")
		expect(entry.serviceKinds).toEqual(["systemone"])
		expect(cfg?.baseUrl).toBe(GOOGLE_URL)
		expect(cfg?.path).toBe("/v1beta/decisions")
	})

	it("declares the two wire differences from the other lanes", () => {
		// Google rejects an API key in Authorization and calls the state `input`.
		expect(cfg?.authHeader).toBe("x-goog-api-key")
		expect(cfg?.stateField).toBe("input")
	})

	it("appears in getProvidersByKind('systemone')", () => {
		const found = getProvidersByKind("systemone").find((provider) => provider.id === "systemone")
		expect(found).toBeDefined()
		expect(found.alias).toBe("systemone")
		expect(found.systemoneConfig?.baseUrl).toBe(GOOGLE_URL)
	})

	it("lists gemini-decision-1 as a System One model", () => {
		const kinds = Object.fromEntries(entry.models.map((model) => [model.id, model.kind]))
		expect(kinds).toEqual({ "gemini-decision-1": "systemone" })
	})

	it("does not displace the existing safeguards reviewer", () => {
		// pickDecisionReviewTarget prefers the lowest priority; a keyed lane must never
		// take over reviews on installs that only configured the free lanes.
		const target = pickDecisionReviewTarget({}, null)
		expect(target?.provider).not.toBe("systemone")
		expect(entry.priority).toBeGreaterThan(60)
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

describe("handleSystemoneCore for systemone", () => {
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
		credentials = { apiKey: "google_test_key" },
		model = "gemini-decision-1",
	) {
		const fetchMock = vi.fn(async () => new Response(JSON.stringify(upstreamReply), { status: 200 }))
		vi.stubGlobal("fetch", fetchMock)
		const result = await handleSystemoneCore({
			body,
			modelInfo: { provider: "systemone", model },
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

	it("posts to the decisions endpoint with x-goog-api-key and no Authorization", async () => {
		const r = await call({ state: "The blue mug arrived cracked.", questions })
		expect(r.result.success).toBe(true)
		expect(r.url).toBe(GOOGLE_URL)
		expect(r.headers["x-goog-api-key"]).toBe("google_test_key")
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
