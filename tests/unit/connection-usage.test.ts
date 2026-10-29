import { describe, expect, it } from "vitest"
import {
	authExpiryVerdict,
	canReadConnectionUsage,
	connectionAfterRefresh,
	customQuotaConnection,
	isApiKeyAuth,
	isAuthExpiredUsage,
	isOAuthConnection,
	NOT_AVAILABLE_MESSAGE,
	quotaProxyOptions,
	refreshFailureMessage,
	tokenUpdateFromRefresh,
} from "../../apps/api/src/domain/connection-usage.ts"

describe("isOAuthConnection / isApiKeyAuth", () => {
	it("accepts both spellings of an API-key connection", () => {
		// Kiro's headless flow stores "api_key"; every other provider stores "apikey".
		expect(isApiKeyAuth({ authType: "apikey" })).toBe(true)
		expect(isApiKeyAuth({ authType: "api_key" })).toBe(true)
		expect(isApiKeyAuth({ authType: "oauth" })).toBe(false)
	})

	it("recognises OAuth and nothing else", () => {
		expect(isOAuthConnection({ authType: "oauth" })).toBe(true)
		expect(isOAuthConnection({ authType: "apikey" })).toBe(false)
		expect(isOAuthConnection(null)).toBe(false)
	})
})

describe("canReadConnectionUsage", () => {
	const providers = ["glm", "minimax", "kiro"]

	it("allows any OAuth connection", () => {
		expect(
			canReadConnectionUsage({
				connection: { authType: "oauth", provider: "not-whitelisted" },
				customQuotaEnabled: false,
				usageApiKeyProviders: providers,
			}),
		).toBe(true)
	})

	it("allows a whitelisted API-key provider", () => {
		expect(
			canReadConnectionUsage({
				connection: { authType: "api_key", provider: "kiro" },
				customQuotaEnabled: false,
				usageApiKeyProviders: providers,
			}),
		).toBe(true)
	})

	it("refuses an API-key provider that has no quota endpoint", () => {
		expect(
			canReadConnectionUsage({
				connection: { authType: "apikey", provider: "openai" },
				customQuotaEnabled: false,
				usageApiKeyProviders: providers,
			}),
		).toBe(false)
	})

	it("allows a custom-quota node even with an ordinary auth type", () => {
		// Eligibility comes through the node here, not the connection.
		expect(
			canReadConnectionUsage({
				connection: { authType: "apikey", provider: "self-hosted" },
				customQuotaEnabled: true,
				usageApiKeyProviders: providers,
			}),
		).toBe(true)
	})

	it("refuses when there is no connection", () => {
		expect(
			canReadConnectionUsage({
				connection: null,
				customQuotaEnabled: true,
				usageApiKeyProviders: providers,
			}),
		).toBe(false)
	})
})

describe("isAuthExpiredUsage", () => {
	it("recognises the phrases providers put in a 200 body", () => {
		expect(isAuthExpiredUsage({ message: "Token expired" })).toBe(true)
		expect(isAuthExpiredUsage({ message: "Authentication failed" })).toBe(true)
		expect(isAuthExpiredUsage({ message: "Unauthorized" })).toBe(true)
		expect(isAuthExpiredUsage({ message: "please re-authorize" })).toBe(true)
		expect(isAuthExpiredUsage({ message: "401 from upstream" })).toBe(true)
	})

	it("does not read a normal quota payload as an expiry", () => {
		expect(isAuthExpiredUsage({ limits: [{ used: 1 }] })).toBe(false)
		expect(isAuthExpiredUsage({ message: "5-hour window" })).toBe(false)
	})

	it("survives a missing or non-object payload", () => {
		expect(isAuthExpiredUsage(null)).toBe(false)
		expect(isAuthExpiredUsage("expired")).toBe(false)
		expect(isAuthExpiredUsage({ message: 401 })).toBe(false)
	})
})

describe("authExpiryVerdict", () => {
	it("passes a normal payload through", () => {
		expect(authExpiryVerdict({ usage: { ok: true }, isOAuth: true, hasRefreshToken: true })).toEqual({
			kind: "ok",
		})
	})

	it("retries once for an OAuth connection that can refresh", () => {
		expect(
			authExpiryVerdict({ usage: { message: "expired" }, isOAuth: true, hasRefreshToken: true }),
		).toEqual({ kind: "retry-after-refresh" })
	})

	it("does not retry an OAuth connection with no refresh token", () => {
		// Retrying repeats the same call and doubles the latency for nothing.
		expect(
			authExpiryVerdict({ usage: { message: "expired" }, isOAuth: true, hasRefreshToken: false }),
		).toEqual({ kind: "ok" })
	})

	it("tells an API-key connection to reconnect, because no refresh can help", () => {
		const verdict = authExpiryVerdict({
			usage: { message: "expired" },
			isOAuth: false,
			hasRefreshToken: false,
		})
		expect(verdict.kind).toBe("reauthorize")
	})
})

describe("tokenUpdateFromRefresh", () => {
	const now = Date.parse("2026-10-29T12:00:00.000Z")

	it("carries every token the refresh returned", () => {
		const update = tokenUpdateFromRefresh({
			refresh: { accessToken: "a", refreshToken: "r", idToken: "i", lastRefreshAt: "then" },
			existingProviderSpecificData: null,
			now,
		})
		expect(update).toMatchObject({
			accessToken: "a",
			refreshToken: "r",
			idToken: "i",
			lastRefreshAt: "then",
			updatedAt: new Date(now).toISOString(),
		})
	})

	it("prefers a relative lifetime over an absolute expiry", () => {
		// expiresIn is what the provider just said; expiresAt may be the value we already had.
		const update = tokenUpdateFromRefresh({
			refresh: { expiresIn: 3600, expiresAt: "1999-01-01T00:00:00.000Z" },
			existingProviderSpecificData: null,
			now,
		})
		expect(update.expiresIn).toBe(3600)
		expect(update.expiresAt).toBe(new Date(now + 3_600_000).toISOString())
	})

	it("falls back to the absolute expiry when no lifetime was given", () => {
		const update = tokenUpdateFromRefresh({
			refresh: { expiresAt: "2026-11-01T00:00:00.000Z" },
			existingProviderSpecificData: null,
			now,
		})
		expect(update.expiresAt).toBe("2026-11-01T00:00:00.000Z")
		expect(update.expiresIn).toBe(undefined)
	})

	it("merges provider-specific data instead of replacing it", () => {
		// Replacing it drops GitHub's non-token fields and logs the account out.
		const update = tokenUpdateFromRefresh({
			refresh: { copilotToken: "new", copilotTokenExpiresAt: "later" },
			existingProviderSpecificData: { copilotToken: "old", enterprise: "acme" },
			now,
		})
		expect(update.providerSpecificData).toEqual({
			copilotToken: "new",
			copilotTokenExpiresAt: "later",
			enterprise: "acme",
		})
	})

	it("leaves provider-specific data absent when the refresh carried none", () => {
		const update = tokenUpdateFromRefresh({
			refresh: { accessToken: "a" },
			existingProviderSpecificData: { enterprise: "acme" },
			now,
		})
		expect(update.providerSpecificData).toBe(undefined)
	})

	it("ignores a zero lifetime rather than writing an expiry of now", () => {
		const update = tokenUpdateFromRefresh({
			refresh: { expiresIn: 0, expiresAt: "2026-11-01T00:00:00.000Z" },
			existingProviderSpecificData: null,
			now,
		})
		expect(update.expiresIn).toBe(undefined)
		expect(update.expiresAt).toBe("2026-11-01T00:00:00.000Z")
	})
})

describe("connectionAfterRefresh", () => {
	const connection = { id: "c1", providerSpecificData: { enterprise: "acme" } }

	it("keeps the connection's provider-specific data when the update has none", () => {
		const merged = connectionAfterRefresh(connection, {})
		expect(merged.providerSpecificData).toEqual({ enterprise: "acme" })
	})

	it("uses the update's provider-specific data when it carried any", () => {
		const merged = connectionAfterRefresh(connection, {
			providerSpecificData: { copilotToken: "new" },
		})
		expect(merged.providerSpecificData).toEqual({ copilotToken: "new" })
	})
})

describe("customQuotaConnection", () => {
	it("points the connection at the node's quota endpoint", () => {
		const merged = customQuotaConnection(
			{ providerSpecificData: { extra: 1 } },
			{ baseUrl: "https://node", quotaPath: "/quota", name: "My node" },
		)
		expect(merged.providerSpecificData).toEqual({
			extra: 1,
			baseUrl: "https://node",
			quotaEnabled: true,
			quotaPath: "/quota",
			nodeName: "My node",
		})
	})

	it("defaults the quota path and keeps an existing base URL", () => {
		const merged = customQuotaConnection(
			{ providerSpecificData: { baseUrl: "https://existing" } },
			{},
		)
		expect(merged.providerSpecificData).toMatchObject({
			baseUrl: "https://existing",
			quotaPath: "/credits",
		})
	})
})

describe("quotaProxyOptions", () => {
	it("never uses a strict proxy, so a dead proxy does not report the account as broken", () => {
		const options = quotaProxyOptions({ connectionProxyEnabled: true })
		expect(options.strictProxy).toBe(false)
		expect(options.connectionProxyEnabled).toBe(true)
	})

	it("normalises missing fields to empty strings", () => {
		expect(quotaProxyOptions({})).toEqual({
			connectionProxyEnabled: false,
			connectionProxyUrl: "",
			connectionNoProxy: "",
			vercelRelayUrl: "",
			strictProxy: false,
		})
	})
})

describe("refreshFailureMessage", () => {
	it("names the provider so the log line is actionable", () => {
		expect(refreshFailureMessage("codex", new Error("boom"))).toBe(
			"[Usage] codex: force refresh failed: boom",
		)
	})

	it("copes with a missing provider and a non-Error reason", () => {
		expect(refreshFailureMessage(undefined, "nope")).toBe(
			"[Usage] unknown: force refresh failed: nope",
		)
	})
})

describe("NOT_AVAILABLE_MESSAGE", () => {
	it("is a single wording for both refusal branches", () => {
		expect(NOT_AVAILABLE_MESSAGE).toBe("Usage not available for this connection")
	})
})
