import { describe, expect, it } from "vitest"
import {
	accountsOf,
	expiresAtOf,
	SERVER_CONTROLLED_FIELDS,
	strippedAccount,
	withImportDefaults,
} from "../../apps/api/src/domain/oauth-import.ts"

describe("accountsOf", () => {
	it("accepts a bare array, which is what an export file holds", () => {
		expect(accountsOf([{ accessToken: "a" }])).toEqual([{ accessToken: "a" }])
	})

	it("accepts a single object pasted from a token file", () => {
		expect(accountsOf({ accessToken: "a" })).toEqual([{ accessToken: "a" }])
	})

	it("accepts the dashboard's own { accounts: [...] } shape", () => {
		expect(accountsOf({ accounts: [{ accessToken: "a" }] })).toEqual([{ accessToken: "a" }])
	})

	it("prefers the wrapper over treating it as one account", () => {
		const wrapped = { accounts: [{ accessToken: "a" }, { accessToken: "b" }] }
		expect(accountsOf(wrapped)).toHaveLength(2)
	})

	it("answers nothing for a body that is not an object", () => {
		expect(accountsOf("nope")).toBeNull()
		expect(accountsOf(null)).toBeNull()
		expect(accountsOf(42)).toBeNull()
	})

	it("passes an empty wrapper through, so the route can refuse it as empty", () => {
		expect(accountsOf({ accounts: [] })).toEqual([])
	})
})

describe("strippedAccount", () => {
	it("drops every field the server owns", () => {
		const result = strippedAccount({
			id: "x",
			provider: "evil",
			authType: "api-key",
			createdAt: "then",
			updatedAt: "then",
			accessToken: "a",
			email: "e@x",
		})
		expect(result.error).toBeUndefined()
		expect(result.account).toEqual({ accessToken: "a", email: "e@x" })
		for (const field of SERVER_CONTROLLED_FIELDS) {
			expect(result.account).not.toHaveProperty(field)
		}
	})

	it("refuses a row with no access token", () => {
		expect(strippedAccount({ email: "e@x" }).error).toBe("Missing accessToken")
		expect(strippedAccount({ accessToken: "" }).error).toBe("Missing accessToken")
		expect(strippedAccount({ accessToken: 42 }).error).toBe("Missing accessToken")
	})

	it("refuses a row that is not an object, naming that rather than the token", () => {
		expect(strippedAccount(null).error).toBe("Item is not an object")
		expect(strippedAccount([{ accessToken: "a" }]).error).toBe("Item is not an object")
		expect(strippedAccount("a").error).toBe("Item is not an object")
	})

	it("does not mutate the row it was given", () => {
		const raw = { id: "x", accessToken: "a" }
		strippedAccount(raw)
		expect(raw).toEqual({ id: "x", accessToken: "a" })
	})
})

describe("expiresAtOf", () => {
	const now = 1_700_000_000_000

	it("keeps an expiry the row already carried", () => {
		expect(expiresAtOf({ expiresAt: "2026-01-01T00:00:00.000Z" }, now)).toBe(
			"2026-01-01T00:00:00.000Z",
		)
	})

	it("computes one from expiresIn, so the credential is not valid forever", () => {
		expect(expiresAtOf({ expiresIn: 3600 }, now)).toBe(new Date(now + 3_600_000).toISOString())
	})

	it("leaves an unusable expiresIn alone rather than inventing an expiry", () => {
		expect(expiresAtOf({ expiresIn: 0 }, now)).toBeUndefined()
		expect(expiresAtOf({ expiresIn: -5 }, now)).toBeUndefined()
		expect(expiresAtOf({ expiresIn: "3600" }, now)).toBeUndefined()
		expect(expiresAtOf({}, now)).toBeUndefined()
	})
})

describe("withImportDefaults", () => {
	const now = 1_700_000_000_000

	it("gives an imported connection the state an OAuth flow would have left it in", () => {
		const result = withImportDefaults({ accessToken: "a" }, now)
		expect(result).toMatchObject({
			testStatus: "active",
			isActive: true,
			lastRefreshAt: new Date(now).toISOString(),
		})
	})

	it("keeps values the caller did send, including an explicit false", () => {
		const result = withImportDefaults({ isActive: false, testStatus: "error" }, now)
		expect(result.isActive).toBe(false)
		expect(result.testStatus).toBe("error")
	})

	it("does not overwrite an existing lastRefreshAt", () => {
		const result = withImportDefaults({ lastRefreshAt: "then" }, now)
		expect(result.lastRefreshAt).toBe("then")
	})
})
