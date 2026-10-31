/**
 * Budget pools: the three ways a shared cap lies.
 *
 * A key in two pools is counted twice (two caps protecting one key, and the page claiming
 * coverage), a deleted key silently frees its share, and a zero cap reads as unlimited while
 * rendering as exhausted. Each case below is one of those.
 */

import { makeBudgetPools } from "9router-api/application/usage/budget-pools"
import {
	type BudgetPool,
	capOf,
	overlappingMembers,
	parsePools,
	poolVerdict,
} from "9router-api/domain/budget-pool"
import { describe, expect, it } from "vitest"

const pool = (over: Partial<BudgetPool> = {}): BudgetPool => ({
	id: "p1",
	name: "Editors",
	cap: 20,
	members: ["k1", "k2"],
	...over,
})

describe("capOf", () => {
	it("accepts a positive finite cap", () => {
		expect(capOf(20)).toBe(20)
		expect(capOf("5")).toBe(5)
	})

	it("refuses a cap that cannot be enforced", () => {
		// A zero cap would make `used / cap` Infinity and mark every new pool exhausted.
		expect(capOf(0)).toBeNull()
		expect(capOf(-1)).toBeNull()
		expect(capOf(Number.NaN)).toBeNull()
		expect(capOf(Number.POSITIVE_INFINITY)).toBeNull()
		expect(capOf(undefined)).toBeNull()
	})
})

describe("parsePools", () => {
	it("drops a row with no id or no cap instead of inventing defaults", () => {
		const parsed = parsePools([
			{ id: "a", cap: 10, members: ["k1"] },
			{ cap: 10, members: ["k2"] },
			{ id: "c", cap: 0, members: ["k3"] },
			null,
			"nope",
		])

		expect(parsed.map((p) => p.id)).toEqual(["a"])
	})

	it("de-duplicates members and falls back to the id for a missing name", () => {
		const [only] = parsePools([{ id: "a", cap: 10, members: ["k1", "k1", "k2"] }])

		expect(only?.members).toEqual(["k1", "k2"])
		expect(only?.name).toBe("a")
	})

	it("answers an empty list for a payload that is not a list", () => {
		expect(parsePools(null)).toEqual([])
		expect(parsePools({ pools: [] })).toEqual([])
	})
})

describe("overlappingMembers", () => {
	it("names a key that appears in two pools", () => {
		expect(
			overlappingMembers([
				pool({ id: "a", members: ["k1", "k2"] }),
				pool({ id: "b", members: ["k2", "k3"] }),
			]),
		).toEqual(["k2"])
	})

	it("answers nothing when every key belongs to one pool", () => {
		expect(
			overlappingMembers([pool({ id: "a", members: ["k1"] }), pool({ id: "b", members: ["k2"] })]),
		).toEqual([])
	})
})

describe("poolVerdict", () => {
	it("sums the members and reports what is left", () => {
		const verdict = poolVerdict(pool(), { k1: 5, k2: 7 }, new Set(["k1", "k2"]))

		expect(verdict.used).toBe(12)
		expect(verdict.remaining).toBe(8)
		expect(verdict.fraction).toBeCloseTo(0.6, 10)
		expect(verdict.exhausted).toBe(false)
	})

	it("clamps the bar when the pool is overspent, and says so", () => {
		const verdict = poolVerdict(pool(), { k1: 30 }, new Set(["k1", "k2"]))

		expect(verdict.used).toBe(30)
		expect(verdict.remaining).toBe(-10)
		expect(verdict.fraction).toBe(1)
		expect(verdict.exhausted).toBe(true)
	})

	it("keeps a deleted member in the verdict instead of freeing its share", () => {
		const verdict = poolVerdict(pool(), { k1: 5, k2: 5 }, new Set(["k1"]))

		expect(verdict.members.find((m) => m.keyId === "k2")?.present).toBe(false)
		expect(verdict.used).toBe(10)
	})

	it("counts a missing or junk counter as zero spend", () => {
		const verdict = poolVerdict(pool(), { k1: Number.NaN, k2: -3 }, new Set(["k1", "k2"]))

		expect(verdict.used).toBe(0)
		expect(verdict.fraction).toBe(0)
	})
})

/** A store whose spend and key list are fixed. */
function store(pools: unknown, spend: Record<string, number> = { k1: 5 }) {
	const written: unknown[] = []
	return {
		written,
		store: {
			read: async () => pools,
			write: async (next: unknown) => {
				written.push(next)
			},
			spend: async () => ({ spendByKey: spend, keyIds: Object.keys(spend) }),
		},
	}
}

describe("makeBudgetPools", () => {
	it("reports a verdict per stored pool", async () => {
		const { store: port } = store([{ id: "p1", name: "Editors", cap: 20, members: ["k1"] }])
		const { pools } = await makeBudgetPools(port).list()

		expect(pools).toHaveLength(1)
		expect(pools[0]?.used).toBe(5)
	})

	it("refuses a list where one key sits in two pools", async () => {
		const { store: port, written } = store([])
		const useCase = makeBudgetPools(port)

		await expect(
			useCase.save({
				pools: [
					{ id: "a", cap: 10, members: ["k1"] },
					{ id: "b", cap: 10, members: ["k1"] },
				],
			}),
		).rejects.toMatchObject({ code: "CONFLICT", status: 409 })
		expect(written).toHaveLength(0)
	})

	it("refuses two pools with one id, which would overwrite silently", async () => {
		const { store: port, written } = store([])

		await expect(
			makeBudgetPools(port).save({
				pools: [
					{ id: "a", cap: 10, members: ["k1"] },
					{ id: "a", cap: 20, members: ["k2"] },
				],
			}),
		).rejects.toMatchObject({ code: "CONFLICT" })
		expect(written).toHaveLength(0)
	})

	it("refuses a pool without a usable cap", async () => {
		const { store: port, written } = store([])

		await expect(
			makeBudgetPools(port).save({ pools: [{ id: "a", cap: 0, members: ["k1"] }] }),
		).rejects.toMatchObject({ code: "VALIDATION", status: 400 })
		expect(written).toHaveLength(0)
	})

	it("writes the parsed list, so junk never reaches storage", async () => {
		const { store: port, written } = store([])

		await makeBudgetPools(port)
			.save({
				pools: [
					{ id: "a", cap: 10, members: ["k1", "k1"] },
					{ id: "b", cap: 0, members: ["k2"] },
				],
			})
			.catch(() => undefined)

		// The refusal above means nothing was written; a clean list writes exactly once.
		expect(written).toHaveLength(0)
		await makeBudgetPools(port).save({ pools: [{ id: "a", cap: 10, members: ["k1", "k1"] }] })
		expect(written).toHaveLength(1)
		expect((written[0] as BudgetPool[])[0]?.members).toEqual(["k1"])
	})
})
