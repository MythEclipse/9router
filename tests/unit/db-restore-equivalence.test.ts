import { beforeEach, describe, expect, it } from "vitest"
import type { ImportProgress } from "@/lib/db/index.js"

// Loaded in beforeEach-adjacent fashion because the db module keeps process-wide state.
const db = await import("@/lib/db/index.js")
const importDb = db.importDb as (p: Record<string, unknown>) => Promise<unknown>
const importDbProgressive = db.importDbProgressive as (
	p: Record<string, unknown>,
	onProgress?: (p: ImportProgress) => void,
) => Promise<unknown>
const exportDb = db.exportDb as () => Promise<Record<string, unknown>>

// Both import paths write the same fourteen sections through the same writers, but they
// split the work differently: importDb puts the whole restore in one transaction,
// importDbProgressive puts each section in its own and reports progress between them.
// The sections themselves used to be written out twice, once per path, so these tests
// compare the two outcomes rather than trusting them to stay in step.

const backup = () => ({
	settings: { siteName: "Kana", theme: "dark" },
	providerConnections: [
		{
			id: "c1",
			provider: "openai",
			authType: "oauth",
			name: "Main",
			priority: 1,
			isActive: true,
			accessToken: "tok",
		},
	],
	providerNodes: [{ id: "n1", type: "openai-compatible", name: "Local", baseUrl: "http://x" }],
	proxyPools: [{ id: "p1", isActive: true, testStatus: "ok", name: "pool" }],
	apiKeys: [
		{
			id: "k1",
			key: "sk-live",
			name: "live",
			isActive: true,
			access: { restricted: true, allow: ["Main"] },
		},
	],
	combos: [{ id: "cb1", name: "fast", kind: "llm", models: ["openai/gpt-4o"] }],
	usageHistory: [
		{
			timestamp: "2024-01-01T00:00:00.000Z",
			provider: "openai",
			model: "gpt-4o",
			promptTokens: 10,
			completionTokens: 5,
			cost: 0.001,
		},
	],
	usageDaily: [{ dateKey: "2024-01-01", data: { requests: 1 } }],
	modelAliases: { "my-model": "openai/gpt-4o" },
	customModels: [{ providerAlias: "openai", id: "custom-1", type: "llm", name: "Custom" }],
	mitmAlias: { cursor: { model: "openai/gpt-4o" } },
	pricing: { openai: { "gpt-4o": { input: 1, output: 2 } } },
	modelOverrides: { "openai/gpt-4o": { hidden: true } },
	disabledModels: { openai: ["gpt-3.5"] },
	autoBackup: { enabled: true, intervalHours: 24 },
})

/**
 * A restore stamps `new Date().toISOString()` on any row the backup left undated, so two
 * runs a few milliseconds apart differ only in those stamps. Compare everything else.
 */
function stampFree(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stampFree)
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {}
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			// Auto-increment ids come from the database's sequence, not from the restore
			// logic, so a second import into a non-empty file always numbers higher.
			if (k === "createdAt" || k === "updatedAt" || k === "lastResetAt" || k === "id") continue
			out[k] = stampFree(v)
		}
		return out
	}
	return value
}

/** Only the sections a restore is expected to round-trip. */
function pickComparable(dump: Record<string, unknown>): Record<string, any> {
	return {
		settings: dump.settings,
		providerConnections: dump.providerConnections,
		providerNodes: dump.providerNodes,
		proxyPools: dump.proxyPools,
		apiKeys: dump.apiKeys,
		combos: dump.combos,
		usageHistory: dump.usageHistory,
	}
}

describe("restore: the two import paths must agree", () => {
	beforeEach(async () => {
		// Start from empty so each case compares like with like.
		await importDb({})
	})

	it("a full backup round-trips through importDb", async () => {
		await importDb(backup())
		const out = await exportDb()
		const got = pickComparable(out)

		expect(got.settings).toMatchObject({ siteName: "Kana", theme: "dark" })
		expect(got.providerConnections).toHaveLength(1)
		expect(got.providerConnections[0]).toMatchObject({ id: "c1", provider: "openai", name: "Main" })
		expect(got.providerNodes[0]).toMatchObject({ id: "n1", name: "Local" })
		expect(got.proxyPools[0]).toMatchObject({ id: "p1", name: "pool" })
		expect(got.apiKeys[0]).toMatchObject({ id: "k1", name: "live" })
		expect(got.combos[0]).toMatchObject({ id: "cb1", name: "fast" })
		expect(got.usageHistory).toHaveLength(1)
	})

	it("a full backup round-trips through importDbProgressive", async () => {
		await importDbProgressive(backup())
		const out = await exportDb()
		const got = pickComparable(out)

		expect(got.settings).toMatchObject({ siteName: "Kana", theme: "dark" })
		expect(got.providerConnections).toHaveLength(1)
		expect(got.apiKeys[0]).toMatchObject({ id: "k1", name: "live" })
		expect(got.combos[0]).toMatchObject({ id: "cb1", name: "fast" })
		expect(got.usageHistory).toHaveLength(1)
	})

	it("both paths produce the same database from the same backup", async () => {
		await importDb(backup())
		const viaOneShot = stampFree(pickComparable(await exportDb()))

		await importDb({})
		await importDbProgressive(backup())
		const viaProgressive = stampFree(pickComparable(await exportDb()))

		expect(viaProgressive).toEqual(viaOneShot)
	})

	it("importDbProgressive reports every section it restored, ending at 100%", async () => {
		const seen: ImportProgress[] = []
		await importDbProgressive(backup(), (p) => seen.push({ ...p }))

		expect(seen.length).toBeGreaterThan(0)
		const last = seen[seen.length - 1]
		expect(last.percent).toBe(100)
		expect(last.currentSection).toBe("done")

		// Progress only moves forward, and never past the total.
		for (let i = 1; i < seen.length; i++) {
			expect(seen[i].done).toBeGreaterThanOrEqual(seen[i - 1].done)
			expect(seen[i].done).toBeLessThanOrEqual(seen[i].total)
		}
		expect(seen.every((p) => p.total === last.total)).toBe(true)
	})
})

describe("restore: a partial backup leaves the rest of the database alone", () => {
	beforeEach(async () => {
		await importDb(backup())
	})

	it("restoring only settings keeps providers and keys", async () => {
		await importDb({ settings: { siteName: "Renamed" } })
		const out = await exportDb()

		expect((out.settings as Record<string, unknown>).siteName).toBe("Renamed")
		// Everything the backup did not carry survives.
		expect(out.providerConnections).toHaveLength(1)
		expect(out.apiKeys).toHaveLength(1)
		expect(out.combos).toHaveLength(1)
	})

	it("restoring only combos keeps api keys, so live traffic is not locked out", async () => {
		await importDb({ combos: [{ id: "cb2", name: "slow", kind: "llm", models: [] }] })
		const out = await exportDb()

		expect(out.apiKeys).toHaveLength(1)
		expect((out.combos as Array<Record<string, unknown>>).map((c) => c.id)).toEqual(["cb2"])
	})

	it("a section present but empty clears that section", async () => {
		await importDb({ combos: [] })
		const out = await exportDb()

		// An explicit empty list means "this backup has no combos", not "skip combos".
		expect(out.combos).toHaveLength(0)
		expect(out.apiKeys).toHaveLength(1)
	})

	it("a backup carrying none of the sections changes nothing", async () => {
		const before = pickComparable(await exportDb())
		await importDb({})
		expect(pickComparable(await exportDb())).toEqual(before)
	})
})

describe("restore: key access survives the trip", () => {
	beforeEach(async () => {
		await importDb({})
	})

	it("keeps a restricted access list", async () => {
		await importDb(backup())
		const out = await exportDb()
		const key = (out.apiKeys as Array<Record<string, unknown>>)[0]
		expect(key.access).toEqual({ restricted: true, allow: ["Main"] })
	})

	it("restores keys from a backup that predates access as unrestricted", async () => {
		await importDb({
			apiKeys: [{ id: "k9", key: "sk-old", name: "old", isActive: true }],
		})
		const out = await exportDb()
		const key = (out.apiKeys as Array<Record<string, unknown>>)[0]
		expect(key.access).toEqual({ restricted: false, allow: [] })
	})

	it("refuses a malformed access list instead of widening it", async () => {
		await expect(
			importDb({
				apiKeys: [
					{ id: "k9", key: "sk-old", name: "old", access: { restricted: true, allow: "not-an-array" } },
				],
			}),
		).rejects.toThrow()
	})
})

describe("restore: an old backup must not reset live usage counters", () => {
	beforeEach(async () => {
		await importDb({})
	})

	it("keeps the live counters when the backup carries no limit columns", async () => {
		await importDb({
			apiKeys: [
				{
					id: "k1",
					key: "sk-live",
					name: "live",
					isActive: true,
					tokenLimit: 1000,
					usedTokens: 500,
					requestLimit: 100,
					usedRequests: 42,
					limitKind: "tokens",
				},
			],
		})

		// A backup written before the limit columns existed.
		await importDb({ apiKeys: [{ id: "k1", key: "sk-live", name: "renamed", isActive: true }] })

		const out = await exportDb()
		const key = (out.apiKeys as Array<Record<string, unknown>>)[0]
		expect(key.name).toBe("renamed")
		expect(key.usedTokens).toBe(500)
		expect(key.usedRequests).toBe(42)
		expect(key.tokenLimit).toBe(1000)
	})
})
