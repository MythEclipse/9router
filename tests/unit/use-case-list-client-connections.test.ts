// Tests for apps/api/src/application/providers/list-client-connections.ts — what
// the usage panel receives: which connections, in what order, cut how.
//
// No existing test file covers this use-case; the whole pipeline lived inline in
// apps/web/src/app/api/providers/client/route.ts.
//
// User instruction, verbatim: "lanjut kenapa malah berhenti".

import { describe, expect, it, vi } from "vitest"
import { makeListClientConnections } from "../../apps/api/src/application/providers/list-client-connections.ts"

const registry = {
	isCompatible: (p: string) => p.startsWith("openai-compatible-"),
	supportsUsage: (p: string) => p === "claude" || p === "gemini",
	supportsApiKeyUsage: (p: string) => p === "gemini",
	usageOrder: ["claude", "gemini"],
}

const stored = [
	{ id: "1", provider: "claude", authType: "oauth", apiKey: "sk-a", priority: 2 },
	{ id: "2", provider: "gemini", authType: "apikey", apiKey: "sk-b", priority: 1 },
	{ id: "3", provider: "kiro", authType: "oauth", apiKey: "sk-c" },
	{
		id: "4",
		provider: "openai-compatible-a",
		providerSpecificData: { baseUrl: "https://x", quotaEnabled: true },
		isActive: false,
	},
	{ id: "5", provider: "claude", authType: "apikey", priority: 3 },
]

function harness(overrides: { connections?: typeof stored; nodes?: unknown[] } = {}) {
	const backfill = vi.fn(async () => {})
	const useCase = makeListClientConnections({
		connections: {
			list: async () => overrides.connections ?? stored,
			find: async () => null,
			create: async () => {
				throw new Error("unused")
			},
			update: async () => null,
			remove: async () => false,
		},
		nodes: {
			list: async () =>
				(overrides.nodes ?? [{ id: "openai-compatible-a", quotaEnabled: true }]) as never,
			find: async () => null,
		},
		registry,
		backfill,
	})
	return { useCase, backfill }
}

describe("eligibility", () => {
	it("keeps only connections whose usage can be read", async () => {
		const { useCase } = harness()
		const listing = await useCase.run({})
		// Kept: claude/oauth (1), gemini/apikey (2), and the compatible node that
		// opted into quota tracking (4). Dropped: kiro, which has no usage endpoint,
		// and claude/apikey (5), whose usage endpoint needs an OAuth token.
		expect(listing.connections.map((c) => c.id)).toEqual(["2", "1", "4"])
	})

	it("lists an inactive connection: eligibility is about usage, not about being in use", async () => {
		const { useCase } = harness()
		const listing = await useCase.run({})
		expect(listing.connections.map((c) => c.id)).toContain("4")
	})

	it("counts eligible and provider-filtered totals separately", async () => {
		const { useCase } = harness()
		const listing = await useCase.run({ provider: "claude" })
		expect(listing.totals.eligibleConnections).toBe(3)
		expect(listing.totals.providerFilteredConnections).toBe(1)
	})

	it("offers only providers that survived eligibility", async () => {
		const { useCase } = harness()
		expect((await useCase.run({})).providerOptions).toEqual([
			"claude",
			"gemini",
			"openai-compatible-a",
		])
	})
})

describe("disclosure", () => {
	it("strips secrets from every row", async () => {
		const { useCase } = harness()
		const listing = await useCase.run({})
		expect(JSON.stringify(listing)).not.toContain("sk-")
		expect(listing.connections[0]).toHaveProperty("id")
		expect(listing.connections[0]).not.toHaveProperty("apiKey")
	})
})

describe("filtering", () => {
	it("passes everything for an unknown provider instead of rejecting", async () => {
		// The panel may hold a stale provider id after a deletion; a 400 would blank
		// the whole panel where an unfiltered list still shows the rest.
		const { useCase } = harness()
		const listing = await useCase.run({ provider: "ghost" })
		expect(listing.connections).toEqual([])
		expect(listing.totals.eligibleConnections).toBe(3)
	})

	it("treats an absent provider as all", async () => {
		const { useCase } = harness()
		expect((await useCase.run({})).connections).toHaveLength(3)
	})

	it("narrows by account status", async () => {
		const { useCase } = harness()
		// Connection 4 is the only one stored as inactive, so it is the only row an
		// `inactive` listing shows — and the empty `active` side is what the panel
		// reads as "nothing disabled right now".
		expect((await useCase.run({ accountStatus: "inactive" })).connections.map((c) => c.id)).toEqual([
			"4",
		])
		expect((await useCase.run({ accountStatus: "active" })).connections.map((c) => c.id)).toEqual([
			"2",
			"1",
		])
	})
})

describe("ordering and paging", () => {
	it("orders by priority by default", async () => {
		const { useCase } = harness()
		expect((await useCase.run({})).connections.map((c) => c.id)).toEqual(["2", "1", "4"])
	})

	it("orders by provider when asked", async () => {
		const { useCase } = harness()
		expect((await useCase.run({ sort: "provider" })).connections.map((c) => c.id)).toEqual([
			"1",
			"2",
			"4",
		])
	})

	it("pages and reports the totals", async () => {
		const many = Array.from({ length: 25 }, (_, i) => ({
			id: `c${i}`,
			provider: "claude",
			authType: "oauth",
			priority: i,
		}))
		const { useCase } = harness({ connections: many as never })
		const listing = await useCase.run({ page: "2", pageSize: "10" })
		expect(listing.connections).toHaveLength(10)
		expect(listing.pagination).toEqual({ page: 2, pageSize: 10, total: 25, totalPages: 3 })
	})
})

describe("backfill ordering", () => {
	it("repairs emails before reading, so the page reflects the repair", async () => {
		// Calling it after the read would show the stale email it was meant to fix.
		const order: string[] = []
		const useCase = makeListClientConnections({
			connections: {
				list: async () => {
					order.push("read")
					return []
				},
				find: async () => null,
				create: async () => {
					throw new Error("unused")
				},
				update: async () => null,
				remove: async () => false,
			},
			nodes: { list: async () => [], find: async () => null },
			registry,
			backfill: async () => {
				order.push("backfill")
			},
		})
		await useCase.run({})
		expect(order).toEqual(["backfill", "read"])
	})
})
