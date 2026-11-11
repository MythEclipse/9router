// Fal API-key validation must probe the model catalog, not queue a paid image.
//
// Pasting a new fal.ai key used to answer "Provider validation not supported",
// because the provider had no probe plan. The saved-connection test already
// checks the key with a catalogue GET; the pre-save path now does the same, so
// a rejected key is reported as rejected, an inconclusive answer (429/5xx) is
// not mislabelled as a bad key, and no generation is ever submitted.
//
// Ported from tests/unit/fal-provider-validation.test.js at 54a88d04 (#993).
// The upstream file drove the Next route directly; the route delegates to
// `application/providers/validate-credential.ts` here, so the graph is assembled
// over the real host probes with only the session and the use-case registry
// faked — the probe itself (what these assertions are about) stays real.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/server", () => ({
	NextResponse: { json: (body, init = {}) => Response.json(body, init) },
}))

const host = await import("@/lib/providerConnectionHost")
const { makeValidateCredential } = await import(
	"../../apps/api/src/application/providers/validate-credential.ts"
)
const validateCredential = makeValidateCredential({
	send: host.sendProbe,
	findNode: async () => null,
	defaultModel: host.defaultModelOf,
	providerConfig: host.providerEntry,
	aiProvider: host.aiProviderEntry,
	normalizeProviderId: host.normalizeProviderId,
	isOpenAICompatible: () => false,
	isAnthropicCompatible: () => false,
	isCustomEmbedding: () => false,
	probeAws: host.probeAwsCredentials,
	probeQoder: host.probeQoderCredentials,
	probeNous: host.probeNousKey,
	ollamaLocalHost: host.ollamaLocalHost,
	tokenplanBaseUrl: host.tokenplanBaseUrl,
	commandCodeBody: host.commandCodeBody,
	commandCodeHeaders: host.commandCodeHeaders,
	randomId: () => "session-id",
})
vi.doMock("@/lib/useCases", () => ({ getUseCases: () => ({ validateCredential }) }))
vi.doMock("@9router/auth/dashboardPermissions", () => ({
	getSessionContext: async () => ({
		session: { userId: "owner-1", email: "owner@local", role: "admin" },
		permissions: [],
		apiKeyFilter: null,
	}),
}))

const { POST } = await import("../../apps/web/src/app/api/providers/validate/route.js")

const request = (apiKey = "fal-test-key", provider = "fal-ai") =>
	new Request("http://localhost/api/providers/validate", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ provider, apiKey }),
	})

const fetchMock = vi.fn()

beforeEach(() => {
	fetchMock.mockReset()
	vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe("Fal API-key validation (#993)", () => {
	it("checks a new key through the model catalog without submitting a generation", async () => {
		fetchMock.mockResolvedValueOnce(Response.json({ models: [] }))
		const response = await POST(request())
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ valid: true, error: null })
		expect(fetchMock).toHaveBeenCalledTimes(1)
		const [url, options] = fetchMock.mock.calls[0]
		expect(url).toBe("https://api.fal.ai/v1/models?limit=1")
		expect(options.method || "GET").toBe("GET")
		expect(options.headers.Authorization).toBe("Key fal-test-key")
		expect(options.body).toBeUndefined()
		expect(options.signal).toBeInstanceOf(AbortSignal)
	})

	it.each([401, 403])("reports a rejected key on HTTP %s", async (status) => {
		fetchMock.mockResolvedValueOnce(new Response("", { status }))
		const response = await POST(request())
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ valid: false, error: "Invalid API key" })
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it.each([429, 500, 503])(
		"does not accept or mislabel an inconclusive HTTP %s as a bad key",
		async (status) => {
			fetchMock.mockResolvedValueOnce(new Response("", { status }))
			const response = await POST(request())
			expect(await response.json()).toEqual({
				valid: false,
				error: `Unable to verify API key (Fal returned ${status})`,
			})
			expect(fetchMock).toHaveBeenCalledTimes(1)
		},
	)

	it("preserves a network error rather than reporting unsupported validation", async () => {
		fetchMock.mockRejectedValueOnce(new Error("network unavailable"))
		const response = await POST(request())
		expect(await response.json()).toEqual({ valid: false, error: "network unavailable" })
	})

	it("still requires a key before making any probe", async () => {
		const response = await POST(request(""))
		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({ error: "Provider and API key required" })
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it("uses the same probe when the provider is supplied by its display name", async () => {
		fetchMock.mockResolvedValueOnce(Response.json({ models: [] }))
		const response = await POST(request("fal-test-key", "Fal.ai"))
		expect(await response.json()).toEqual({ valid: true, error: null })
		expect(fetchMock.mock.calls[0][0]).toBe("https://api.fal.ai/v1/models?limit=1")
	})
})
