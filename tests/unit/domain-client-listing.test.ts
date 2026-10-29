// Tests for apps/api/src/domain/client-listing.ts — what the usage panel may see.
//
// No existing test file covers this: the whitelist, masking, eligibility, sort and
// paging lived inline in apps/web/src/app/api/providers/client/route.ts.
//
// User instruction, verbatim: "lanjut kenapa malah berhenti".

import { describe, expect, it } from "vitest"
import {
	isAccountStatus,
	isConnectionSort,
	isUsageEligible,
	MAX_PAGE_SIZE,
	maskName,
	matchesAccountStatus,
	paginate,
	parsePositiveInt,
	type RawConnection,
	resolvePageSize,
	sanitizeConnection,
	sortConnections,
} from "../../apps/api/src/domain/client-listing.ts"

const registry = {
	isCompatible: (p: string) => p.startsWith("openai-compatible-"),
	supportsUsage: (p: string) => p === "claude" || p === "gemini",
	supportsApiKeyUsage: (p: string) => p === "gemini",
	usageOrder: ["claude", "gemini"],
}

describe("maskName", () => {
	it("leaves a short name alone", () => {
		expect(maskName("work")).toBe("work")
	})

	it("leaves a long human-readable name alone", () => {
		expect(maskName("personal claude account")).toBe("personal claude account")
	})

	it("masks a long opaque token down to eight characters", () => {
		const token = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345"
		expect(maskName(token)).toBe(`${token.slice(0, 8)}***`)
	})

	it("passes a non-string through untouched", () => {
		expect(maskName(undefined)).toBeUndefined()
		expect(maskName(42)).toBe(42)
	})
})

describe("sanitizeConnection", () => {
	it("drops every field not on the whitelist", () => {
		const safe = sanitizeConnection({
			id: "c1",
			provider: "claude",
			authType: "oauth",
			apiKey: "sk-secret",
			accessToken: "at-secret",
			refreshToken: "rt-secret",
			idToken: "it-secret",
		})
		expect(safe).toEqual({ id: "c1", provider: "claude", authType: "oauth" })
		expect(JSON.stringify(safe)).not.toContain("secret")
	})

	it("masks a name that carries a token", () => {
		const token = "abcdefghijklmnopqrstuvwxyz012345"
		const safe = sanitizeConnection({ provider: "claude", name: token })
		expect(safe.name).toBe("abcdefgh***")
	})

	it("keeps only whitelisted providerSpecificData fields", () => {
		const safe = sanitizeConnection({
			provider: "openai-compatible-x",
			providerSpecificData: {
				baseUrl: "https://x.test",
				quotaEnabled: true,
				apiKey: "sk-secret",
				connectionProxyUrl: "http://user:pass@proxy:8080",
			},
		})
		expect(safe.providerSpecificData).toEqual({
			baseUrl: "https://x.test",
			quotaEnabled: true,
		})
	})

	it("leaves providerSpecificData absent rather than emptying it", () => {
		// The panel distinguishes "no extra config" from "withheld"; an empty object
		// would erase that distinction.
		expect(sanitizeConnection({ provider: "claude" })).not.toHaveProperty("providerSpecificData")
	})

	it("keeps an explicitly empty providerSpecificData as an empty object", () => {
		expect(sanitizeConnection({ provider: "claude", providerSpecificData: {} })).toHaveProperty(
			"providerSpecificData",
			{},
		)
	})
})

describe("isUsageEligible", () => {
	const nodes = new Map([["openai-compatible-a", { quotaEnabled: true }]])

	it("asks the node for a compatible provider's quota flag", () => {
		expect(
			isUsageEligible({ provider: "openai-compatible-a" }, nodes, {
				...registry,
				isCompatible: () => true,
			}),
		).toBe(true)
		expect(
			isUsageEligible({ provider: "openai-compatible-b" }, nodes, {
				...registry,
				isCompatible: () => true,
			}),
		).toBe(false)
	})

	it("accepts an OAuth account of a provider with a usage endpoint", () => {
		expect(isUsageEligible({ provider: "claude", authType: "oauth" }, nodes, registry)).toBe(true)
	})

	it("accepts an api-key account only where the usage endpoint takes a key", () => {
		expect(isUsageEligible({ provider: "gemini", authType: "apikey" }, nodes, registry)).toBe(true)
		expect(isUsageEligible({ provider: "claude", authType: "apikey" }, nodes, registry)).toBe(false)
	})

	it("refuses a provider with no usage endpoint at all", () => {
		expect(isUsageEligible({ provider: "kiro", authType: "oauth" }, nodes, registry)).toBe(false)
	})
})

describe("account status", () => {
	it("reads an absent isActive as active", () => {
		expect(matchesAccountStatus({ provider: "p" }, "active")).toBe(true)
		expect(matchesAccountStatus({ provider: "p" }, "inactive")).toBe(false)
	})

	it("passes everything for all", () => {
		for (const c of [{ isActive: true }, { isActive: false }, {}] as RawConnection[]) {
			expect(matchesAccountStatus(c, "all")).toBe(true)
		}
	})

	it("recognises only the three statuses", () => {
		expect(isAccountStatus("all")).toBe(true)
		expect(isAccountStatus("active")).toBe(true)
		expect(isAccountStatus("inactive")).toBe(true)
		expect(isAccountStatus("enabled")).toBe(false)
	})
})

describe("sortConnections", () => {
	const list: RawConnection[] = [
		{ provider: "kiro", priority: 3 },
		{ provider: "claude" },
		{ provider: "gemini", priority: 1 },
		{ provider: "claude", priority: 2 },
	]

	it("orders by priority and puts unset priorities last", () => {
		// An absent priority is not priority zero; treating it as such would float
		// every unconfigured account to the top.
		expect(sortConnections(list, "priority", registry).map((c) => c.provider)).toEqual([
			"gemini",
			"claude",
			"kiro",
			"claude",
		])
	})

	it("orders by the registry's usage order, then alphabetically", () => {
		expect(sortConnections(list, "provider", registry).map((c) => c.provider)).toEqual([
			"claude",
			"claude",
			"gemini",
			"kiro",
		])
	})

	it("does not mutate the input", () => {
		const input = [...list]
		sortConnections(input, "provider", registry)
		expect(input.map((c) => c.provider)).toEqual(["kiro", "claude", "gemini", "claude"])
	})

	it("recognises only the two sort keys", () => {
		expect(isConnectionSort("priority")).toBe(true)
		expect(isConnectionSort("provider")).toBe(true)
		expect(isConnectionSort("name")).toBe(false)
	})
})

describe("parsePositiveInt", () => {
	it("reads a plain positive integer", () => {
		expect(parsePositiveInt("7", 1)).toBe(7)
	})

	it("falls back for an absent or empty value", () => {
		expect(parsePositiveInt(null, 20)).toBe(20)
		expect(parsePositiveInt("", 20)).toBe(20)
	})

	it("falls back for zero and negatives instead of accepting them", () => {
		expect(parsePositiveInt("0", 1)).toBe(1)
		expect(parsePositiveInt("-3", 1)).toBe(1)
	})

	it("reads the leading digits of a partly numeric value", () => {
		expect(parsePositiveInt("12abc", 1)).toBe(12)
	})
})

describe("resolvePageSize", () => {
	it("defaults to 20", () => {
		expect(resolvePageSize(null)).toBe(20)
	})

	it("clamps to the ceiling", () => {
		expect(resolvePageSize("100000")).toBe(MAX_PAGE_SIZE)
	})
})

describe("paginate", () => {
	const items = Array.from({ length: 45 }, (_, i) => i + 1)

	it("cuts the requested page", () => {
		const page = paginate(items, 2, 20)
		expect(page.items).toEqual([
			21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40,
		])
		expect(page.page).toBe(2)
		expect(page.totalPages).toBe(3)
	})

	it("clamps a page past the end to the last page instead of returning nothing", () => {
		// The panel keeps its page number across a filter change, so page 9 of what
		// is now 3 pages must still show rows.
		const page = paginate(items, 9, 20)
		expect(page.page).toBe(3)
		expect(page.items).toHaveLength(5)
	})

	it("reports one page for an empty list", () => {
		expect(paginate([], 1, 20)).toEqual({ items: [], page: 1, totalPages: 1 })
	})

	it("clamps page zero up to the first page", () => {
		expect(paginate(items, 0, 20).page).toBe(1)
	})
})
