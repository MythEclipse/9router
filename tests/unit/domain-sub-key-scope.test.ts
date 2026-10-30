import { describe, expect, it } from "vitest"

import {
	asKeyPermissions,
	clampAllowedModels,
	clampEndpoints,
	mayCreateSubKey,
	parseCreatorPatterns,
	permissionsForSubKey,
	scopeSubKey,
} from "../../apps/api/src/domain/sub-key-scope.ts"

/** Mirrors packages/db `matchesAllowedModels`: exact, `prefix*`, `*suffix`, `*`. */
function matches(patterns: readonly string[], model: string): boolean {
	const req = model.trim().toLowerCase()
	return patterns.some((allowed) => {
		if (allowed === "*" || allowed === req) return true
		if (allowed.endsWith("*")) return req.startsWith(allowed.slice(0, -1))
		if (allowed.startsWith("*")) return req.endsWith(allowed.slice(1))
		return false
	})
}

const defaults = { viewUsage: true, manageApiKeys: false }

describe("scopeSubKey token cap", () => {
	it("refuses a token limit above the creator's", () => {
		const result = scopeSubKey({ tokenLimit: 500 }, { tokenLimit: 100 }, matches)
		expect(result).toEqual({
			ok: false,
			error: { field: "tokenLimit", creatorMax: 100 },
		})
	})

	it("allows a limit at or below the creator's", () => {
		const result = scopeSubKey({ tokenLimit: 100 }, { tokenLimit: 100 }, matches)
		expect(result.ok && result.value.tokenLimit).toBe(100)
	})

	it("treats a creator limit of zero as unlimited", () => {
		const result = scopeSubKey({ tokenLimit: 999_999 }, { tokenLimit: 0 }, matches)
		expect(result.ok && result.value.tokenLimit).toBe(999_999)
	})

	it("treats an absent creator limit as unlimited", () => {
		const result = scopeSubKey({ tokenLimit: 5 }, {}, matches)
		expect(result.ok).toBe(true)
	})

	it("coerces a string limit and treats junk as no cap", () => {
		const numeric = scopeSubKey({ tokenLimit: "250" }, { tokenLimit: 300 }, matches)
		expect(numeric.ok && numeric.value.tokenLimit).toBe(250)

		const junk = scopeSubKey({ tokenLimit: "abc" }, { tokenLimit: 300 }, matches)
		expect(junk.ok && junk.value.tokenLimit).toBe(0)
	})
})

describe("scopeSubKey cost cap", () => {
	it("refuses a daily cost above the creator's", () => {
		const result = scopeSubKey({ dailyCostLimit: 50 }, { dailyCostLimit: 10 }, matches)
		expect(result).toEqual({
			ok: false,
			error: { field: "dailyCostLimit", creatorMax: 10 },
		})
	})

	it("reports the token cap first when both are exceeded", () => {
		const result = scopeSubKey(
			{ tokenLimit: 500, dailyCostLimit: 50 },
			{ tokenLimit: 100, dailyCostLimit: 10 },
			matches,
		)
		expect(!result.ok && result.error.field).toBe("tokenLimit")
	})
})

describe("clampAllowedModels", () => {
	it("passes the request through when the creator is unrestricted", () => {
		expect(clampAllowedModels("gpt-4o", null, matches)).toBe("gpt-4o")
	})

	it("defaults an unrestricted creator's unconstrained request to a wildcard", () => {
		expect(clampAllowedModels(null, null, matches)).toBe("*")
	})

	it("turns a wildcard request into exactly the creator's list", () => {
		expect(clampAllowedModels("*", ["gpt-4o", "claude-*"], matches)).toBe("gpt-4o,claude-*")
	})

	it("turns an empty request into the creator's list", () => {
		expect(clampAllowedModels("", ["gpt-4o"], matches)).toBe("gpt-4o")
	})

	it("keeps only the patterns the creator can reach", () => {
		expect(clampAllowedModels("gpt-4o,claude-3,llama-3", ["gpt-*"], matches)).toBe("gpt-4o")
	})

	it("falls back to the creator's list when nothing survives", () => {
		expect(clampAllowedModels("llama-3", ["gpt-4o"], matches)).toBe("gpt-4o")
	})

	it("honours a suffix wildcard on the creator", () => {
		expect(clampAllowedModels("claude-3-opus", ["*opus"], matches)).toBe("claude-3-opus")
	})

	it("honours a prefix wildcard on the creator", () => {
		expect(clampAllowedModels("claude-3-opus", ["claude-*"], matches)).toBe("claude-3-opus")
	})

	it("lowercases and trims what it returns", () => {
		expect(clampAllowedModels(" GPT-4O ", ["gpt-*"], matches)).toBe("gpt-4o")
	})
})

describe("parseCreatorPatterns", () => {
	it("treats a wildcard as unrestricted", () => {
		expect(parseCreatorPatterns("*")).toBeNull()
	})

	it("treats an empty value as unrestricted", () => {
		expect(parseCreatorPatterns("")).toBeNull()
		expect(parseCreatorPatterns(null)).toBeNull()
	})

	it("splits a comma list into patterns", () => {
		expect(parseCreatorPatterns("GPT-4o, claude-*")).toEqual(["gpt-4o", "claude-*"])
	})
})

describe("clampEndpoints", () => {
	it("intersects rather than unions", () => {
		expect(clampEndpoints(["chat", "admin"], ["chat", "embeddings"])).toEqual(["chat"])
	})

	it("falls back to the creator's endpoints when asked for nothing", () => {
		expect(clampEndpoints([], ["chat"])).toEqual(["chat"])
		expect(clampEndpoints(null, ["chat"])).toEqual(["chat"])
	})

	it("falls back to the creator's endpoints when nothing survives", () => {
		expect(clampEndpoints(["admin"], ["chat"])).toEqual(["chat"])
	})

	it("passes the request through when the creator lists no endpoints", () => {
		expect(clampEndpoints(["chat"], [])).toEqual(["chat"])
	})
})

describe("mayCreateSubKey", () => {
	it("always allows a password session", () => {
		expect(mayCreateSubKey("admin", null)).toBe(true)
		expect(mayCreateSubKey(null, null)).toBe(true)
	})

	it("refuses a key session without the permission", () => {
		expect(mayCreateSubKey("apikey", defaults)).toBe(false)
		expect(mayCreateSubKey("apikey", null)).toBe(false)
	})

	it("allows a key session that holds the permission", () => {
		expect(mayCreateSubKey("apikey", { viewUsage: true, manageApiKeys: true })).toBe(true)
	})
})

describe("permissionsForSubKey", () => {
	it("ignores what a key session asks for", () => {
		expect(
			permissionsForSubKey("apikey", { viewUsage: true, manageApiKeys: true }, defaults),
		).toEqual(defaults)
	})

	it("honours what a password session asks for", () => {
		const asked = { viewUsage: false, manageApiKeys: true }
		expect(permissionsForSubKey("admin", asked, defaults)).toEqual(asked)
	})

	it("falls back to the defaults when nothing is asked", () => {
		expect(permissionsForSubKey("admin", null, defaults)).toEqual(defaults)
	})
})

describe("asKeyPermissions", () => {
	// This is the entry point to the whole chain above: `callerFromSession` passes it whatever the
	// session carries, and `mayCreateSubKey` then decides whether that caller may mint a key. A
	// truthy value here is the difference between "may not" and "may" escalate.

	it("only `true` grants a flag, so a stray string cannot stand in for a permission", () => {
		for (const value of ["true", 1, "yes", {}, [], "1"]) {
			const permissions = asKeyPermissions({ manageApiKeys: value, viewUsage: value })
			expect(permissions?.manageApiKeys, `${JSON.stringify(value)} must not grant`).toBe(false)
			expect(permissions?.viewUsage, `${JSON.stringify(value)} must not grant`).toBe(false)
		}
	})

	it("keeps an explicit false as false", () => {
		const permissions = asKeyPermissions({ viewUsage: false, manageApiKeys: false })
		expect(permissions).toMatchObject({ viewUsage: false, manageApiKeys: false })
	})

	it("fills a missing flag with false rather than leaving it undefined", () => {
		// A caller that reads `permissions.manageApiKeys` must see a boolean even when the session
		// omitted the field.
		const permissions = asKeyPermissions({})
		expect(permissions).toEqual({ viewUsage: false, manageApiKeys: false })
	})

	it("carries the other flags through untouched, because the sidebar reads them by name", () => {
		const permissions = asKeyPermissions({
			viewUsage: true,
			manageApiKeys: false,
			manageProviders: true,
			manageModels: true,
		})
		expect(permissions).toMatchObject({
			manageProviders: true,
			manageModels: true,
		})
	})

	it("answers null for anything that is not an object, so no caller inherits a permissive default", () => {
		for (const value of [null, undefined, "admin", 42, true]) {
			expect(asKeyPermissions(value), `${JSON.stringify(value)} must be null`).toBeNull()
		}
	})

	it("an array is an object, so it normalises to a permissions map with nothing granted", () => {
		// Recorded rather than refused: the input is a JSON body, and an array reaching here grants
		// no flag, so the outcome is closed even though the shape is odd.
		expect(asKeyPermissions([])).toEqual({ viewUsage: false, manageApiKeys: false })
	})

	it("a normalised key session is still refused when it lacks manageApiKeys", () => {
		// The shape `callerFromSession` builds, fed to the rule that gates minting.
		const permissions = asKeyPermissions({ viewUsage: true, manageApiKeys: "true" })
		expect(mayCreateSubKey("apikey", permissions)).toBe(false)
	})

	it("a normalised key session that holds manageApiKeys may mint", () => {
		const permissions = asKeyPermissions({ viewUsage: true, manageApiKeys: true })
		expect(mayCreateSubKey("apikey", permissions)).toBe(true)
	})
})
