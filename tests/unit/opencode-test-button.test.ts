import { beforeEach, describe, expect, it, vi } from "vitest"

// The dashboard Test button must report what a real request would do. A GET
// probe answers 200 even while every free chat call is 429, so the probe has to
// ride the internal chat route where the executor's harness actually runs.
const { pingMock, connectionMock } = vi.hoisted(() => ({
	pingMock: vi.fn(),
	connectionMock: vi.fn(),
}))

vi.mock("@/app/api/models/test/ping", () => ({
	pingModelByKind: pingMock,
	WEB_COOKIE_PROVIDERS: new Set(),
}))
vi.mock("@/lib/localDb", async (importOriginal) => ({
	...(await importOriginal()),
	getProviderConnectionById: connectionMock,
	updateProviderConnection: vi.fn(),
}))
vi.mock("@/lib/network/connectionProxy", () => ({
	resolveConnectionProxyConfig: vi.fn(async () => ({})),
}))
vi.mock("@/lib/network/proxyTest", () => ({ testProxyUrl: vi.fn() }))

import { testSingleConnection } from "../../apps/web/src/app/api/providers/[id]/test/testUtils.js"

describe("opencode Test button", () => {
	beforeEach(() => {
		pingMock.mockReset()
		connectionMock.mockReset()
		// opencode is an api-key connection, so the probe goes through
		// testApiKeyConnection where the case lives.
		connectionMock.mockResolvedValue({
			id: "c1",
			provider: "opencode",
			authType: "apikey",
			apiKey: "public",
			providerSpecificData: {},
		})
	})

	it("probes the chat lane rather than a GET that cannot see the gate", async () => {
		pingMock.mockResolvedValue({ ok: true, status: 200, latencyMs: 12, error: null })
		const result = await testSingleConnection("c1")

		expect(result.valid).toBe(true)
		expect(pingMock).toHaveBeenCalledOnce()
		const [model, kind, baseUrl] = pingMock.mock.calls[0]
		// Routed through the alias the chat route resolves, as an llm call.
		expect(String(model)).toMatch(/^oc1\//)
		expect(kind).toBe("llm")
		expect(String(baseUrl)).toMatch(/^http:\/\/127\.0\.0\.1:/)
	})

	it("reports the free-usage limit instead of a green check", async () => {
		pingMock.mockResolvedValue({ ok: false, status: 429, latencyMs: 30, error: "HTTP 429" })
		const result = await testSingleConnection("c1")

		expect(result.valid).toBe(false)
		expect(result.error).toMatch(/usage limit/i)
	})

	it("passes an upstream failure through instead of hiding it", async () => {
		pingMock.mockResolvedValue({
			ok: false,
			status: 502,
			latencyMs: 30,
			error: "HTTP 502: bad gateway",
		})
		const result = await testSingleConnection("c1")

		expect(result.valid).toBe(false)
		expect(result.error).toContain("502")
	})
})
