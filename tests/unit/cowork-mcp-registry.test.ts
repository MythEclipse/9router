import { describe, expect, it } from "vitest"
import {
	dedupeByUrl,
	isDirectConnect,
	needsUncollectedFields,
	toRegistryServer,
} from "../../apps/api/src/domain/cowork-mcp-registry.ts"

/**
 * Cowork runs in 3p mode, so a registry entry that only works when brokered through claude.ai
 * becomes a plugin that fails on first use — which the operator reads as "9Router is broken".
 * These are the refusals that keep those entries off the screen.
 */

describe("isDirectConnect", () => {
	it("accepts a plain https MCP endpoint", () => {
		expect(isDirectConnect("https://mcp.exa.ai/mcp")).toBe(true)
	})

	it("refuses servers Anthropic brokers, which are broken in 3p", () => {
		expect(isDirectConnect("https://mcp.claude.com/sse")).toBe(false)
		expect(isDirectConnect("https://api.anthropic.com/mcp")).toBe(false)
	})

	it("refuses an unsubstituted URL template", () => {
		expect(isDirectConnect("https://mcp.example.com/{tenant}/sse")).toBe(false)
		expect(isDirectConnect("https://mcp.example.com/<id>")).toBe(false)
	})

	it("refuses plaintext, which would send the key in the clear", () => {
		expect(isDirectConnect("http://mcp.example.com/mcp")).toBe(false)
	})

	it("refuses a missing or non-string url", () => {
		expect(isDirectConnect(undefined)).toBe(false)
		expect(isDirectConnect("")).toBe(false)
		expect(isDirectConnect(42)).toBe(false)
	})
})

describe("needsUncollectedFields", () => {
	it("flags entries whose extra fields the form cannot collect", () => {
		expect(needsUncollectedFields(["tenantId"])).toBe(true)
		expect(needsUncollectedFields([])).toBe(false)
		expect(needsUncollectedFields(undefined)).toBe(false)
	})
})

describe("toRegistryServer", () => {
	const item = {
		server: {
			name: "exa",
			title: "Exa",
			description: "Search",
			remotes: [{ url: "https://mcp.exa.ai/mcp", type: "http" }],
		},
		_meta: {
			"com.anthropic.api/mcp-registry": {
				slug: "exa-slug",
				isAuthless: false,
				toolNames: ["search", "fetch"],
				iconUrl: "https://x/icon.png",
			},
		},
	}

	it("maps a servable entry into the shape the screen lists", () => {
		expect(toRegistryServer(item)).toEqual({
			name: "exa",
			slug: "exa-slug",
			title: "Exa",
			description: "Search",
			url: "https://mcp.exa.ai/mcp",
			transport: "http",
			oauth: true,
			toolNames: ["search", "fetch"],
			toolCount: 2,
			iconUrl: "https://x/icon.png",
		})
	})

	it("reports sse transport only when the remote says so", () => {
		const sse = {
			server: { name: "x", remotes: [{ url: "https://x/sse", type: "sse" }] },
			_meta: {},
		}
		expect(toRegistryServer(sse)?.transport).toBe("sse")
	})

	it("returns null for a brokered or tenant-required entry", () => {
		const brokered = {
			server: { name: "x", remotes: [{ url: "https://mcp.claude.com/sse" }] },
			_meta: {},
		}
		expect(toRegistryServer(brokered)).toBe(null)

		const tenant = {
			...item,
			_meta: {
				"com.anthropic.api/mcp-registry": {
					...item._meta["com.anthropic.api/mcp-registry"],
					requiredFields: ["tenantId"],
				},
			},
		}
		expect(toRegistryServer(tenant)).toBe(null)
	})

	it("falls back through title and description rather than showing blanks", () => {
		const sparse = {
			server: { name: "bare", remotes: [{ url: "https://x/mcp" }] },
			_meta: { "com.anthropic.api/mcp-registry": { displayName: "Bare", oneLiner: "One line" } },
		}
		const server = toRegistryServer(sparse)
		expect(server?.title).toBe("Bare")
		expect(server?.description).toBe("One line")
		expect(server?.slug).toBe("bare")
	})

	it("refuses an entry with no name, which nothing could be keyed by", () => {
		expect(toRegistryServer({ server: { remotes: [{ url: "https://x/mcp" }] }, _meta: {} })).toBe(
			null,
		)
	})
})

describe("dedupeByUrl", () => {
	it("keeps the first entry per url", () => {
		const a = { name: "a", url: "https://x/mcp" }
		const b = { name: "b", url: "https://x/mcp" }
		const c = { name: "c", url: "https://y/mcp" }
		expect(dedupeByUrl([a, b, c] as never).map((s) => s.name)).toEqual(["a", "c"])
	})
})
