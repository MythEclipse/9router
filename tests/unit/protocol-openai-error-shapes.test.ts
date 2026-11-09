// Every OpenAI-protocol endpoint must answer errors in ONE envelope:
//   { error: { message, type, code } }
// Hand-written bodies drift (a 404 typed "not_found", a missing code), and
// OpenAI SDKs key off `code` as much as `type`.
import { afterEach, describe, expect, it, vi } from "vitest"
import { GET as voicesGET } from "../../apps/web/src/app/api/v1/audio/voices/route.js"
import { GET as modelsInfoGET } from "../../apps/web/src/app/api/v1/models/info/route.js"

/**
 * The voices route reads its catalogue through the process-wide use-case graph,
 * which opens the SQLite store on first use. These tests are about the route's
 * error mapping — which envelope, which status — so the graph is replaced by the
 * one port the route actually touches. Driving the port directly is also the
 * only way to reach the passthrough branch without seeding a provider
 * connection: with the real graph and an empty test database the route stops at
 * "No deepgram connection found" (400) long before any upstream status exists.
 */
const ttsVoices = vi.hoisted(() => ({
	deepgram: vi.fn(),
	inworld: vi.fn(),
	listing: vi.fn(),
}))

vi.mock("@/lib/useCases", () => ({ getUseCases: () => ({ ttsVoices }) }))

function assertOpenAiEnvelope(body, { type, code }) {
	expect(body.type, "OpenAI bodies never carry an Anthropic `type` field").toBeUndefined()
	expect(body.error).toBeDefined()
	expect(typeof body.error.message).toBe("string")
	expect(body.error.type).toBe(type)
	expect(body.error.code).toBe(code)
}

describe("GET /v1/models/info — OpenAI error envelope", () => {
	it("answers a missing id with type invalid_request_error + code bad_request", async () => {
		const res = await modelsInfoGET(new Request("https://router.test/v1/models/info"))
		expect(res.status).toBe(400)
		assertOpenAiEnvelope(await res.json(), { type: "invalid_request_error", code: "bad_request" })
	})

	it("answers an unknown model with code model_not_found", async () => {
		const res = await modelsInfoGET(new Request("https://router.test/v1/models/info?id=nope/ghost"))
		expect(res.status).toBe(404)
		assertOpenAiEnvelope(await res.json(), { type: "invalid_request_error", code: "model_not_found" })
	})

	it("keeps CORS on the error response", async () => {
		const res = await modelsInfoGET(new Request("https://router.test/v1/models/info"))
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*")
	})
})

describe("GET /v1/audio/voices — OpenAI error envelope", () => {
	afterEach(() => {
		vi.resetAllMocks()
	})

	it("rejects an unknown provider with the shared envelope", async () => {
		const res = await voicesGET(new Request("https://router.test/v1/audio/voices?provider=nope"))
		expect(res.status).toBe(400)
		const body = await res.json()
		assertOpenAiEnvelope(body, { type: "invalid_request_error", code: "bad_request" })
		expect(body.error.message).toContain("provider must be one of")
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*")
		expect(ttsVoices.listing).not.toHaveBeenCalled()
	})

	it("surfaces an unreachable voices API as a 502 with code bad_gateway", async () => {
		// A transport failure carries no status, so the route falls back to 502
		// rather than inventing a client error.
		ttsVoices.listing.mockRejectedValue(new Error("connection refused"))
		const res = await voicesGET(
			new Request("https://router.test/v1/audio/voices?provider=elevenlabs"),
		)
		expect(ttsVoices.listing).toHaveBeenCalledWith({ provider: "elevenlabs", lang: undefined })
		expect(res.status).toBe(502)
		assertOpenAiEnvelope(await res.json(), { type: "server_error", code: "bad_gateway" })
	})

	it("passes an upstream failure through with the upstream status", async () => {
		// A rate limit is the client's signal to back off: folding it into 502
		// would make every SDK retry instead of waiting.
		ttsVoices.deepgram.mockRejectedValue(Object.assign(new Error("quota exhausted"), { status: 429 }))
		const res = await voicesGET(new Request("https://router.test/v1/audio/voices?provider=deepgram"))
		expect(res.status).toBe(429)
		const body = await res.json()
		assertOpenAiEnvelope(body, { type: "rate_limit_error", code: "rate_limit_exceeded" })
		expect(body.error.message).toBe("quota exhausted")
	})
})
