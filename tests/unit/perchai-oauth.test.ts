import { describe, expect, it } from "vitest"
import { normalizePerchExpiry } from "../../open-sse/shared/perchCredentials"
import perchai from "../../src/lib/oauth/providers/perchai"

describe("Perch AI OAuth", () => {
	it("builds a PKCE authorization URL and supports provider selection", () => {
		const authUrl = perchai.buildAuthUrl(
			perchai.config,
			"http://localhost:8080/callback",
			"state-value",
			"challenge-value",
			{ socialProvider: "github" },
		)
		const url = new URL(authUrl)

		expect(url.searchParams.get("provider")).toBe("github")
		expect(url.searchParams.get("redirect_to")).toBe("http://localhost:8080/callback")
		expect(url.searchParams.get("code_challenge")).toBe("challenge-value")
		expect(url.searchParams.get("code_challenge_method")).toBe("s256")
		expect(url.searchParams.get("state")).toBe("state-value")
	})

	it("maps OAuth tokens into the provider connection format", () => {
		const result = perchai.mapTokens({
			access_token: "perch-access-token",
			refresh_token: "perch-refresh-token",
			expires_in: 1800,
			user: { id: "user-123", email: "user@example.com" },
		})

		expect(result).toMatchObject({
			accessToken: "perch-access-token",
			refreshToken: "perch-refresh-token",
			expiresIn: 1800,
			email: "user@example.com",
			providerSpecificData: {
				userId: "user-123",
				authMethod: "oauth",
			},
		})
	})

	it("rejects token payloads without an access token", () => {
		expect(() => perchai.mapTokens({ refresh_token: "refresh-only" })).toThrow(
			"Perch AI token response did not contain an access token",
		)
	})

	it("normalizes expiration timestamps from seconds, milliseconds, and ISO values", () => {
		expect(normalizePerchExpiry(1_700_000_000)).toBe(1_700_000_000)
		expect(normalizePerchExpiry(1_700_000_000_000)).toBe(1_700_000_000)
		expect(normalizePerchExpiry("2023-11-14T22:13:20.000Z")).toBe(1_700_000_000)
	})
})
