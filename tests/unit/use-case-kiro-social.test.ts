import { describe, expect, it, vi } from "vitest"
import {
	authorizeKiroSocial,
	exchangeKiroSocial,
} from "../../apps/api/src/application/oauth/kiro-social.ts"
import {
	KIRO_SOCIAL_PROVIDERS,
	kiroExpiryFrom,
	kiroSocialLabels,
	readKiroSocialExchange,
	readKiroSocialProvider,
} from "../../apps/api/src/domain/kiro-social.ts"

describe("readKiroSocialProvider", () => {
	it("accepts the two providers Kiro supports", () => {
		for (const provider of KIRO_SOCIAL_PROVIDERS) {
			expect(readKiroSocialProvider(provider, "no").provider).toBe(provider)
		}
	})

	it("normalises case and surrounding space", () => {
		expect(readKiroSocialProvider("  GitHub ", "no").provider).toBe("github")
	})

	it("answers the caller's own refusal text for anything else", () => {
		expect(readKiroSocialProvider("apple", "Invalid provider. Use 'google' or 'github'")).toEqual({
			ok: false,
			error: "Invalid provider. Use 'google' or 'github'",
		})
	})

	it("refuses a missing provider", () => {
		expect(readKiroSocialProvider(null, "no").ok).toBe(false)
		expect(readKiroSocialProvider(42, "no").ok).toBe(false)
	})
})

describe("readKiroSocialExchange", () => {
	it("reads the three fields the exchange needs", () => {
		const read = readKiroSocialExchange({ code: "c", codeVerifier: "v", provider: "google" })
		expect(read.input).toEqual({ code: "c", codeVerifier: "v", provider: "google" })
	})

	it("reports missing fields before blaming the provider", () => {
		// Pointing at the provider first would send the operator to the rarer mistake.
		expect(readKiroSocialExchange({ provider: "apple" })).toEqual({
			ok: false,
			error: "Missing required fields",
		})
	})

	it("refuses an unsupported provider when the fields are present", () => {
		expect(readKiroSocialExchange({ code: "c", codeVerifier: "v", provider: "apple" })).toEqual({
			ok: false,
			error: "Invalid provider",
		})
	})
})

describe("kiroSocialLabels", () => {
	it("keeps the machine-readable name and the display label distinct", () => {
		expect(kiroSocialLabels("github")).toEqual({ authMethod: "github", provider: "Github" })
	})
})

describe("kiroExpiryFrom", () => {
	it("converts seconds-since-now into the ISO string the row stores", () => {
		expect(kiroExpiryFrom(3600, 0)).toBe("1970-01-01T01:00:00.000Z")
	})
})

/** Deps where the PKCE values are fixed, so assertions can name them. */
function authorizeDeps() {
	return {
		generatePkce: () => ({
			codeVerifier: "verifier-1",
			codeChallenge: "challenge-1",
			state: "state-1",
		}),
		buildLoginUrl: vi.fn(
			(provider: string, challenge: string, state: string) =>
				`https://kiro/auth?p=${provider}&c=${challenge}&s=${state}`,
		),
	}
}

describe("authorizeKiroSocial", () => {
	it("answers a URL and the verifier the client must send back", () => {
		const host = authorizeDeps()
		const answer = authorizeKiroSocial("google", host)

		expect(answer).toEqual({
			ok: true,
			status: 200,
			body: {
				authUrl: "https://kiro/auth?p=google&c=challenge-1&s=state-1",
				state: "state-1",
				codeVerifier: "verifier-1",
				codeChallenge: "challenge-1",
				provider: "google",
			},
		})
	})

	it("builds the URL with the challenge, never the verifier", () => {
		const host = authorizeDeps()
		authorizeKiroSocial("github", host)
		expect(host.buildLoginUrl).toHaveBeenCalledWith("github", "challenge-1", "state-1")
	})

	it("refuses an unknown provider without building a URL", () => {
		const host = authorizeDeps()
		const answer = authorizeKiroSocial("apple", host)

		expect(answer.status).toBe(400)
		expect(answer.body.error).toBe("Invalid provider. Use 'google' or 'github'")
		expect(host.buildLoginUrl).not.toHaveBeenCalled()
	})
})

function exchangeDeps(
	tokens?: Partial<{
		accessToken: string
		refreshToken: string
		expiresIn: number
		profileArn: string
	}>,
) {
	return {
		exchangeCode: vi.fn(async () => ({
			accessToken: "at-1",
			refreshToken: "rt-1",
			expiresIn: 3600,
			profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/P",
			...tokens,
		})),
		emailFromToken: vi.fn(() => "a@b.c" as string | null),
		createConnection: vi.fn(async (input: Record<string, unknown>) => ({
			id: "conn-1",
			provider: "kiro",
			email: String(input.email),
		})),
		now: () => 1_700_000_000_000,
	}
}

describe("exchangeKiroSocial", () => {
	it("exchanges the code and writes the connection", async () => {
		const host = exchangeDeps()
		const answer = await exchangeKiroSocial(
			{ code: "c", codeVerifier: "v", provider: "github" },
			host,
		)

		expect(answer.ok).toBe(true)
		expect(host.exchangeCode).toHaveBeenCalledWith("c", "v")
	})

	it("records both spellings of the provider on the row", async () => {
		const host = exchangeDeps()
		await exchangeKiroSocial({ code: "c", codeVerifier: "v", provider: "github" }, host)

		const written = host.createConnection.mock.calls[0][0] as Record<string, unknown>
		expect(written.providerSpecificData).toMatchObject({
			authMethod: "github",
			provider: "Github",
		})
	})

	it("stores the expiry derived from expiresIn, not a fixed lifetime", async () => {
		const host = exchangeDeps()
		await exchangeKiroSocial({ code: "c", codeVerifier: "v", provider: "google" }, host)

		const written = host.createConnection.mock.calls[0][0] as Record<string, unknown>
		expect(written.expiresAt).toBe(kiroExpiryFrom(3600, 1_700_000_000_000))
	})

	it("writes no row when the code is refused", async () => {
		const host = exchangeDeps()
		host.exchangeCode.mockRejectedValueOnce(new Error("invalid_grant"))
		const answer = await exchangeKiroSocial(
			{ code: "bad", codeVerifier: "v", provider: "google" },
			host,
		)

		expect(answer).toEqual({ ok: false, status: 500, body: { error: "invalid_grant" } })
		expect(host.createConnection).not.toHaveBeenCalled()
	})

	it("still connects when the token carries no email", async () => {
		// The email is a label, not a credential.
		const host = exchangeDeps()
		host.emailFromToken.mockReturnValueOnce(null)
		const answer = await exchangeKiroSocial(
			{ code: "c", codeVerifier: "v", provider: "google" },
			host,
		)

		expect(answer.ok).toBe(true)
		const written = host.createConnection.mock.calls[0][0] as Record<string, unknown>
		expect(written.email).toBeNull()
	})

	it("refuses a body missing the verifier without calling the exchange", async () => {
		const host = exchangeDeps()
		const answer = await exchangeKiroSocial({ code: "c", provider: "google" }, host)

		expect(answer).toEqual({ ok: false, status: 400, body: { error: "Missing required fields" } })
		expect(host.exchangeCode).not.toHaveBeenCalled()
	})
})
