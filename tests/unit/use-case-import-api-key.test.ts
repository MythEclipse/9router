import { describe, expect, it, vi } from "vitest"
import {
	API_KEY_HORIZON_MS,
	importKiroApiKey,
	importMimoApiKey,
} from "../../apps/api/src/application/oauth/import-api-key.ts"

const now = () => 1_700_000_000_000

/** A host whose provider calls are stubbed; each test overrides only what it is about. */
function kiroHost(overrides: Record<string, unknown> = {}) {
	return {
		now,
		check: vi.fn(async () => ({
			validated: true,
			modelCount: 0,
			accessToken: "bearer",
			email: "a@b.c",
			providerSpecificData: { region: "us-east-1", profileArn: "arn:x" },
		})),
		create: vi.fn(async (input: Record<string, unknown>) => ({
			id: "conn-1",
			provider: String(input.provider),
			email: "a@b.c",
		})),
		...overrides,
	}
}

describe("importKiroApiKey", () => {
	it("refuses an empty key before checking anything", async () => {
		const host = kiroHost()
		const result = await importKiroApiKey({ apiKey: "   " }, host as never)
		expect(result).toEqual({ ok: false, status: 400, error: "API key is required" })
		expect(host.check).not.toHaveBeenCalled()
	})

	it("defaults the region to the one AWS uses when the form left it blank", async () => {
		const host = kiroHost()
		await importKiroApiKey({ apiKey: "k" }, host as never)
		expect(host.check).toHaveBeenCalledWith({ apiKey: "k", region: "us-east-1" })
	})

	it("stores a year-long expiry, since the key has none of its own", async () => {
		const host = kiroHost()
		await importKiroApiKey({ apiKey: "k" }, host as never)
		expect(host.create).toHaveBeenCalledWith(
			expect.objectContaining({
				expiresAt: new Date(now() + API_KEY_HORIZON_MS).toISOString(),
				refreshToken: null,
			}),
		)
	})

	it("records the key as an api_key, not as an OAuth connection", async () => {
		const host = kiroHost()
		await importKiroApiKey({ apiKey: "k" }, host as never)
		expect(host.create).toHaveBeenCalledWith(
			expect.objectContaining({
				authType: "api_key",
				providerSpecificData: expect.objectContaining({
					authMethod: "api_key",
					provider: "API Key",
				}),
			}),
		)
	})

	it("refuses rather than storing a key it could not check at all", async () => {
		const host = kiroHost({
			check: vi.fn(async () => {
				throw new Error("upstream 500 with a body that names the endpoint")
			}),
		})
		const result = await importKiroApiKey({ apiKey: "k" }, host as never)
		expect(result).toEqual({ ok: false, status: 502, error: "API key validation failed" })
		expect(host.create).not.toHaveBeenCalled()
	})
})

function mimoHost(overrides: Record<string, unknown> = {}) {
	return {
		now,
		check: vi.fn(async () => ({ validated: true, modelCount: 12, accessToken: "sk-1" })),
		create: vi.fn(async (input: Record<string, unknown>) => ({
			id: "conn-new",
			provider: String(input.provider),
			email: null,
		})),
		findExisting: vi.fn(async () => null),
		update: vi.fn(async () => undefined),
		...overrides,
	}
}

describe("importMimoApiKey", () => {
	it("refuses a request with neither a key nor a session", async () => {
		const host = mimoHost()
		const result = await importMimoApiKey({}, host as never)
		expect(result).toEqual({ ok: false, status: 400, error: "API key is required" })
	})

	it("refuses a key with the wrong prefix, which the provider would reject anyway", async () => {
		const host = mimoHost()
		const result = await importMimoApiKey({ apiKey: "nokey" }, host as never)
		expect(result).toEqual({
			ok: false,
			status: 400,
			error: "Invalid key format - expected sk- prefix",
		})
	})

	it("accepts a session with no key at all", async () => {
		const host = mimoHost()
		const result = await importMimoApiKey({ mimoPassToken: "session" }, host as never)
		expect(result.ok).toBe(true)
		expect(host.check).not.toHaveBeenCalled()
	})

	it("stores a session-only import as oauth, the authType the dashboard filters on", async () => {
		const host = mimoHost()
		await importMimoApiKey({ mimoPassToken: "session" }, host as never)
		expect(host.create).toHaveBeenCalledWith(
			expect.objectContaining({
				authType: "oauth",
				testStatus: "active",
				providerSpecificData: expect.objectContaining({
					authMethod: "session",
					provider: "Session Login",
				}),
			}),
		)
	})

	it("stores an unchecked key as untested rather than refusing it", async () => {
		const host = mimoHost({
			check: vi.fn(async () => {
				throw new Error("network blocked")
			}),
		})
		const result = await importMimoApiKey({ apiKey: "sk-1" }, host as never)
		expect(result.ok).toBe(true)
		expect(host.create).toHaveBeenCalledWith(
			expect.objectContaining({ testStatus: "untested", accessToken: "sk-1" }),
		)
	})

	it("updates the row a re-import already made instead of adding a second", async () => {
		const host = mimoHost({
			findExisting: vi.fn(async () => ({ id: "conn-old", provider: "xiaomi-mimo" })),
		})
		const result = await importMimoApiKey({ apiKey: "sk-1", uid: "u1" }, host as never)
		expect(host.create).not.toHaveBeenCalled()
		expect(host.update).toHaveBeenCalledWith(
			"conn-old",
			expect.objectContaining({ accessToken: "sk-1" }),
		)
		expect(result).toMatchObject({ ok: true, updated: true })
	})

	it("does not blank a stored token when a session-only re-import has no key", async () => {
		const host = mimoHost({
			findExisting: vi.fn(async () => ({ id: "conn-old", provider: "xiaomi-mimo" })),
		})
		await importMimoApiKey({ mimoPassToken: "session" }, host as never)
		const calls = (host.update as unknown as { mock: { calls: [string, Record<string, unknown>][] } })
			.mock.calls
		const patch = calls[0][1]
		expect(patch.accessToken).toBeUndefined()
	})

	it("names the connection after the account, so two accounts are distinguishable", async () => {
		const host = mimoHost()
		await importMimoApiKey({ apiKey: "sk-1", uid: "u1" }, host as never)
		expect(host.create).toHaveBeenCalledWith(
			expect.objectContaining({ email: "u1@xiaomi", displayName: "Xiaomi u1" }),
		)
	})

	it("tells the caller how many models the key can reach", async () => {
		const host = mimoHost()
		const result = await importMimoApiKey({ apiKey: "sk-1" }, host as never)
		expect(result).toMatchObject({ ok: true, validated: true, modelCount: 12 })
	})
})
