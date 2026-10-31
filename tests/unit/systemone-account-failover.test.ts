import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
	getProviderCredentials: vi.fn(),
	markAccountUnavailable: vi.fn(),
	clearAccountError: vi.fn(),
	extractApiKey: vi.fn(() => null),
	isValidApiKey: vi.fn(),
	getSettings: vi.fn(),
	getModelInfo: vi.fn(),
	getKeyAccessContext: vi.fn(),
	enforceKeyAccessResolved: vi.fn(),
	handleSystemoneCore: vi.fn(),
	checkAndRefreshToken: vi.fn(),
}))

vi.mock("@/sse/services/auth.js", () => ({
	getProviderCredentials: mocks.getProviderCredentials,
	markAccountUnavailable: mocks.markAccountUnavailable,
	shouldTryNextAccount: (connectionId, status, shouldFallback) =>
		shouldFallback || (status === 429 && Boolean(connectionId) && connectionId !== "noauth"),
	clearAccountError: mocks.clearAccountError,
	extractApiKey: mocks.extractApiKey,
	isValidApiKey: mocks.isValidApiKey,
	shouldLogAuthFailure: vi.fn(() => false),
}))

vi.mock("@/lib/localDb", async (importOriginal) => ({
	...(await importOriginal()),
	getSettings: mocks.getSettings,
}))

vi.mock("@/sse/services/model.js", () => ({
	getModelInfo: mocks.getModelInfo,
	getComboModels: vi.fn().mockResolvedValue(null),
}))

vi.mock("@/sse/services/keyAccess.js", () => ({
	getKeyAccessContext: mocks.getKeyAccessContext,
	enforceKeyAccess: vi.fn().mockResolvedValue(null),
	enforceKeyAccessResolved: mocks.enforceKeyAccessResolved,
}))

vi.mock("open-sse/handlers/systemoneCore.js", () => ({
	handleSystemoneCore: mocks.handleSystemoneCore,
}))

vi.mock("@/sse/services/tokenRefresh.js", () => ({
	checkAndRefreshToken: mocks.checkAndRefreshToken,
}))

vi.mock("@/lib/usageDb.js", () => ({
	saveRequestUsage: vi.fn(),
}))

vi.mock("@/sse/utils/logger.js", () => ({
	request: vi.fn(),
	info: vi.fn(),
	debug: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	maskKey: vi.fn(() => "masked"),
}))

import { handleSystemone } from "@/sse/handlers/systemone.js"

describe("System One account failover", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.getSettings.mockResolvedValue({ requireApiKey: false })
		mocks.getModelInfo.mockResolvedValue({ provider: "v1m", model: "rev-latest" })
		mocks.getKeyAccessContext.mockResolvedValue(null)
		mocks.enforceKeyAccessResolved.mockResolvedValue(null)
		mocks.checkAndRefreshToken.mockImplementation(async (_provider, credentials) => credentials)
		mocks.getProviderCredentials
			.mockResolvedValueOnce({
				apiKey: "limited-key",
				connectionId: "limited-connection",
				connectionName: "Limited key",
			})
			.mockResolvedValueOnce({
				apiKey: "healthy-key",
				connectionId: "healthy-connection",
				connectionName: "Healthy key",
			})
		mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false, cooldownMs: 0 })
		mocks.handleSystemoneCore
			.mockResolvedValueOnce({
				success: false,
				status: 429,
				error: "quota exceeded",
				response: new Response(JSON.stringify({ error: { message: "quota exceeded" } }), {
					status: 429,
				}),
			})
			.mockResolvedValueOnce({
				success: true,
				usage: null,
				response: new Response(JSON.stringify({ decision: "healthy account" }), { status: 200 }),
			})
	})

	it("uses the next key after 429 even when account marking declines fallback", async () => {
		const response = await handleSystemone(
			new Request("http://localhost/v1/systemone", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "v1m/rev-latest",
					state: {},
					questions: { q: "?" },
				}),
			}),
		)

		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ decision: "healthy account" })
		expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(2)
		expect(mocks.handleSystemoneCore).toHaveBeenCalledTimes(2)
		expect(mocks.handleSystemoneCore.mock.calls[1][0].credentials.apiKey).toBe("healthy-key")
	})
})
