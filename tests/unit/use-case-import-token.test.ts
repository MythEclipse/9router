import { describe, expect, it, vi } from "vitest"
import {
	importCodexToken,
	importKiroToken,
	needsRemoteVerification,
	saveVerified,
} from "../../apps/api/src/application/oauth/import-token.ts"
import {
	type CodexTokenClaims,
	codexClaimsOf,
	codexConnectionName,
	DEFAULT_TOKEN_LIFETIME_SECONDS,
	identityFieldOf,
	isIdcToken,
	kiroAuthMethodOf,
	kiroProviderLabelOf,
	kiroRegionOf,
	missingImportField,
	textFieldOf,
	tokenExpiryOf,
	validationStatusOf,
} from "../../apps/api/src/domain/credential-import.ts"

describe("textFieldOf", () => {
	it("trims, because a pasted token carries a trailing newline", () => {
		expect(textFieldOf("  tok\n")).toBe("tok")
	})

	it("answers empty for anything that is not a string", () => {
		expect(textFieldOf(undefined)).toBe("")
		expect(textFieldOf(42)).toBe("")
		expect(textFieldOf({})).toBe("")
	})
})

describe("identityFieldOf", () => {
	it("takes a numeric id as text, which JSON bodies often send", () => {
		expect(identityFieldOf(12345)).toBe("12345")
	})

	it("answers empty for absent values, so the required check can see them", () => {
		expect(identityFieldOf(undefined)).toBe("")
		expect(identityFieldOf(null)).toBe("")
	})
})

describe("missingImportField", () => {
	it("asks for the token first, since every caller has one to paste", () => {
		expect(missingImportField({ accessToken: "", identity: "" })?.message).toBe(
			"Access token is required",
		)
	})

	it("asks for the identity when the token is there", () => {
		expect(missingImportField({ accessToken: "t", identity: "" })?.message).toBe(
			"User id is required",
		)
	})

	it("names the identity field the provider calls it", () => {
		expect(
			missingImportField({ accessToken: "t", identity: "", identityName: "Account id" })?.message,
		).toBe("Account id is required")
	})

	it("passes when the identity was not asked for at all", () => {
		expect(missingImportField({ accessToken: "t" })).toBeNull()
	})

	it("passes when everything is present", () => {
		expect(missingImportField({ accessToken: "t", identity: "u" })).toBeNull()
	})
})

describe("isIdcToken", () => {
	it("needs both halves to be an organisation token", () => {
		expect(isIdcToken("id", "secret")).toBe(true)
		expect(isIdcToken("id", "")).toBe(false)
		expect(isIdcToken("", "secret")).toBe(false)
		expect(isIdcToken("", "")).toBe(false)
	})
})

describe("kiroAuthMethodOf and kiroProviderLabelOf", () => {
	it("records the two shapes under the names the refresh path reads", () => {
		expect(kiroAuthMethodOf(true)).toBe("idc")
		expect(kiroAuthMethodOf(false)).toBe("imported")
		expect(kiroProviderLabelOf(true)).toBe("Enterprise")
		expect(kiroProviderLabelOf(false)).toBe("Imported")
	})
})

describe("kiroRegionOf", () => {
	it("defaults to the region AWS uses for an account that never chose one", () => {
		expect(kiroRegionOf("")).toBe("us-east-1")
	})

	it("keeps the region the operator named", () => {
		expect(kiroRegionOf("eu-west-1")).toBe("eu-west-1")
	})
})

describe("tokenExpiryOf", () => {
	const now = 1_700_000_000_000

	it("uses the lifetime the provider stated", () => {
		expect(tokenExpiryOf(600, now)).toBe(new Date(now + 600_000).toISOString())
	})

	it("falls back to an hour rather than issuing a token that never expires", () => {
		const fallback = new Date(now + DEFAULT_TOKEN_LIFETIME_SECONDS * 1000).toISOString()
		expect(tokenExpiryOf(undefined, now)).toBe(fallback)
		expect(tokenExpiryOf(0, now)).toBe(fallback)
		expect(tokenExpiryOf(-5, now)).toBe(fallback)
	})
})

describe("validationStatusOf", () => {
	it("blames the token only when the provider said the token was refused", () => {
		expect(validationStatusOf({ status: 401 })).toBe(401)
		expect(validationStatusOf({ status: 403 })).toBe(401)
	})

	it("does not tell the operator to re-authenticate when the provider is down", () => {
		expect(validationStatusOf({ status: 500 })).toBe(502)
		expect(validationStatusOf(new Error("timeout"))).toBe(502)
		expect(validationStatusOf(undefined)).toBe(502)
	})
})

/** A host whose provider calls are stubbed; each test overrides only what it is about. */
const host = (overrides: Record<string, unknown> = {}) => ({
	now: () => 1_700_000_000_000,
	verify: vi.fn(async () => ({ accessToken: "verified", expiresIn: 600 })),
	create: vi.fn(async (input: Record<string, unknown>) => ({
		id: "conn-1",
		provider: String(input.provider),
		email: null,
	})),
	...overrides,
})

describe("saveVerified", () => {
	it("does not write a row when verification fails", async () => {
		const deps = host({
			verify: vi.fn(async () => {
				throw Object.assign(new Error("bad token"), { status: 401 })
			}),
		})
		const result = await saveVerified({ accessToken: "t" }, "zed", deps as never)
		expect(result).toEqual({ ok: false, status: 401, error: "bad token" })
		expect(deps.create).not.toHaveBeenCalled()
	})

	it("reports a provider outage as 502, not as a bad token", async () => {
		const deps = host({
			verify: vi.fn(async () => {
				throw Object.assign(new Error("upstream 503"), { status: 503 })
			}),
		})
		const result = await saveVerified({ accessToken: "t" }, "zed", deps as never)
		expect(result).toMatchObject({ ok: false, status: 502 })
	})

	it("refuses an empty token before calling the provider at all", async () => {
		const deps = host()
		const result = await saveVerified({ accessToken: "  " }, "zed", deps as never)
		expect(result).toEqual({ ok: false, status: 400, error: "Access token is required" })
		expect(deps.verify).not.toHaveBeenCalled()
	})

	it("writes the connection the provider confirmed, marked active", async () => {
		const deps = host()
		await saveVerified({ accessToken: "t" }, "cursor", deps as never)
		expect(deps.create).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "cursor",
				authType: "oauth",
				accessToken: "verified",
				testStatus: "active",
			}),
		)
	})

	it("keeps the caller's provider data alongside what verification added", async () => {
		const deps = host({
			verify: vi.fn(async () => ({
				accessToken: "v",
				providerSpecificData: { userId: "from-provider" },
			})),
		})
		await saveVerified(
			{ accessToken: "t", providerSpecificData: { systemId: "sys" } },
			"zed",
			deps as never,
		)
		expect(deps.create).toHaveBeenCalledWith(
			expect.objectContaining({
				providerSpecificData: { systemId: "sys", userId: "from-provider" },
			}),
		)
	})
})

describe("importKiroToken", () => {
	it("refuses a body with no refresh token", async () => {
		const deps = host()
		const result = await importKiroToken({}, deps as never)
		expect(result).toEqual({ ok: false, status: 400, error: "Refresh token is required" })
		expect(deps.verify).not.toHaveBeenCalled()
	})

	it("refreshes the pasted token and records it when the provider sends no new one", async () => {
		const deps = host()
		await importKiroToken({ refreshToken: "  aorAAAAAGx  " }, deps as never)
		expect(deps.verify).toHaveBeenCalledWith(expect.objectContaining({ accessToken: "aorAAAAAGx" }))
		expect(deps.create).toHaveBeenCalledWith(expect.objectContaining({ refreshToken: "aorAAAAAGx" }))
	})

	it("keeps the rotated refresh token when the provider issues one", async () => {
		const deps = host({
			verify: vi.fn(async () => ({ accessToken: "a", refreshToken: "rotated" })),
		})
		await importKiroToken({ refreshToken: "old" }, deps as never)
		expect(deps.create).toHaveBeenCalledWith(expect.objectContaining({ refreshToken: "rotated" }))
	})

	it("records an organisation token as IDC and keeps its credentials", async () => {
		const deps = host()
		await importKiroToken(
			{ refreshToken: "t", clientId: "cid", clientSecret: "sec", region: "eu-west-1" },
			deps as never,
		)
		expect(deps.create).toHaveBeenCalledWith(
			expect.objectContaining({
				providerSpecificData: expect.objectContaining({
					authMethod: "idc",
					provider: "Enterprise",
					clientId: "cid",
					clientSecret: "sec",
					region: "eu-west-1",
				}),
			}),
		)
	})

	it("records a social token without inventing organisation credentials", async () => {
		const deps = host()
		await importKiroToken({ refreshToken: "t" }, deps as never)
		const written = (deps.create as { mock: { calls: [Record<string, unknown>][] } }).mock.calls[0][0]
		const data = written.providerSpecificData as Record<string, unknown>
		expect(data.authMethod).toBe("imported")
		expect(data).not.toHaveProperty("clientId")
		expect(data).not.toHaveProperty("clientSecret")
	})

	it("prefers the profile ARN the caller sent over the one the provider returned", async () => {
		const deps = host({
			verify: vi.fn(async () => ({
				accessToken: "a",
				providerSpecificData: { profileArn: "arn:from-provider" },
			})),
		})
		await importKiroToken({ refreshToken: "t", profileArn: "arn:from-form" }, deps as never)
		expect(deps.create).toHaveBeenCalledWith(
			expect.objectContaining({
				providerSpecificData: expect.objectContaining({ profileArn: "arn:from-form" }),
			}),
		)
	})

	it("falls back to the provider's profile ARN when the form had none", async () => {
		const deps = host({
			verify: vi.fn(async () => ({
				accessToken: "a",
				providerSpecificData: { profileArn: "arn:from-provider" },
			})),
		})
		await importKiroToken({ refreshToken: "t" }, deps as never)
		expect(deps.create).toHaveBeenCalledWith(
			expect.objectContaining({
				providerSpecificData: expect.objectContaining({ profileArn: "arn:from-provider" }),
			}),
		)
	})
})

/** A JWT with the claims Codex puts in its own access tokens. */
function codexJwt(claims: Record<string, unknown>): string {
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
	return `${encode({ alg: "none" })}.${encode(claims)}.signature`
}

describe("codexClaimsOf", () => {
	it("reads the email, workspace and plan out of the OpenAI claim namespaces", () => {
		const claims = codexClaimsOf(
			codexJwt({
				"https://api.openai.com/auth": {
					chatgpt_account_id: "acct-1",
					chatgpt_plan_type: "plus",
				},
				"https://api.openai.com/profile": { email: "a@b.c" },
				exp: 1_800_000_000,
			}),
		)
		expect(claims).toEqual({
			email: "a@b.c",
			chatgptAccountId: "acct-1",
			chatgptPlanType: "plus",
			expiresAtEpoch: 1_800_000_000,
		})
	})

	it("falls back through the flat email fields in the order OpenAI means them", () => {
		expect(codexClaimsOf(codexJwt({ email: "flat@b.c" })).email).toBe("flat@b.c")
		expect(codexClaimsOf(codexJwt({ preferred_username: "user@b.c" })).email).toBe("user@b.c")
	})

	it("answers no claims for a token that is not a JWT, rather than refusing it", () => {
		const claims: CodexTokenClaims = codexClaimsOf("not-a-jwt")
		expect(claims.email).toBeNull()
		expect(claims.chatgptAccountId).toBeNull()
	})

	it("answers no claims for a JWT whose payload is not JSON", () => {
		expect(codexClaimsOf("aaa.bbb.ccc").email).toBeNull()
	})
})

describe("codexConnectionName", () => {
	const claims = { ...codexClaimsOf("x"), email: "a@b.c" }

	it("prefers the name the operator typed", () => {
		expect(codexConnectionName("Work", claims)).toBe("Work")
	})

	it("uses the email second, so the row is identifiable", () => {
		expect(codexConnectionName("", claims)).toBe("a@b.c")
	})

	it("falls back to a fixed label rather than an anonymous row", () => {
		expect(codexConnectionName("", codexClaimsOf("x"))).toBe("ChatGPT Access Token")
	})
})

describe("needsRemoteVerification", () => {
	it("skips the provider call only for a token whose claims are its own", () => {
		expect(needsRemoteVerification("codex")).toBe(false)
		expect(needsRemoteVerification("kiro")).toBe(true)
		expect(needsRemoteVerification("zed")).toBe(true)
	})
})

describe("importCodexToken", () => {
	it("stores an access_token, not oauth, because it cannot be refreshed", async () => {
		const deps = host()
		await importCodexToken({ accessToken: codexJwt({ email: "a@b.c" }) }, deps as never)
		expect(deps.create).toHaveBeenCalledWith(
			expect.objectContaining({ provider: "codex", authType: "access_token" }),
		)
		expect(deps.verify).not.toHaveBeenCalled()
	})

	it("records the workspace and plan the token carries", async () => {
		const deps = host()
		await importCodexToken(
			{
				accessToken: codexJwt({
					"https://api.openai.com/auth": {
						chatgpt_account_id: "acct-1",
						chatgpt_plan_type: "pro",
					},
				}),
			},
			deps as never,
		)
		expect(deps.create).toHaveBeenCalledWith(
			expect.objectContaining({
				providerSpecificData: expect.objectContaining({
					chatgptAccountId: "acct-1",
					chatgptPlanType: "pro",
				}),
			}),
		)
	})

	it("refuses an empty token before writing anything", async () => {
		const deps = host()
		const result = await importCodexToken({ accessToken: "  " }, deps as never)
		expect(result).toEqual({ ok: false, status: 400, error: "Access token is required" })
		expect(deps.create).not.toHaveBeenCalled()
	})
})
