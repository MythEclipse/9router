import {
	fastestP95Of,
	HEALTH_MIN_SAMPLES,
	type HealthStats,
	healthScore,
	NEUTRAL_HEALTH_SCORE,
	rankByHealth,
} from "9router-api/domain/connection-health"
import { describe, expect, it } from "vitest"

const stats = (overrides: Partial<HealthStats> = {}): HealthStats => ({
	samples: HEALTH_MIN_SAMPLES,
	successRate: 1,
	p95LatencyMs: 1_000,
	...overrides,
})

describe("healthScore", () => {
	it("is neutral without enough samples", () => {
		expect(healthScore(stats({ samples: HEALTH_MIN_SAMPLES - 1 }), 1_000)).toBe(NEUTRAL_HEALTH_SCORE)
		expect(healthScore(null, 1_000)).toBe(NEUTRAL_HEALTH_SCORE)
	})

	it("scores a perfect account at the pool's best latency as 1", () => {
		expect(healthScore(stats(), 1_000)).toBeCloseTo(1, 5)
	})

	it("scores a slower account lower than a faster one", () => {
		const fast = healthScore(stats({ p95LatencyMs: 1_000 }), 1_000)
		const slow = healthScore(stats({ p95LatencyMs: 10_000 }), 1_000)
		expect(slow).toBeLessThan(fast)
	})

	it("punishes a failing account more than a slow one", () => {
		const failing = healthScore(stats({ successRate: 0.5, p95LatencyMs: 1_000 }), 1_000)
		const slow = healthScore(stats({ successRate: 1, p95LatencyMs: 4_000 }), 1_000)
		expect(failing).toBeLessThan(slow)
	})

	it("cannot go below zero or above one", () => {
		expect(healthScore(stats({ successRate: -3 }), 1_000)).toBeGreaterThanOrEqual(0)
		expect(healthScore(stats({ successRate: 9 }), 1_000)).toBeLessThanOrEqual(1)
	})
})

describe("fastestP95Of", () => {
	it("ignores accounts without enough samples", () => {
		const pool = [{ id: "a" }, { id: "b" }]
		const fastest = fastestP95Of(pool, (id) =>
			id === "a" ? stats({ samples: 1, p95LatencyMs: 10 }) : stats({ p95LatencyMs: 500 }),
		)
		expect(fastest).toBe(500)
	})
})

describe("rankByHealth", () => {
	it("keeps priority as the operator's intent, health only inside a tier", () => {
		const pool = [
			{ id: "primary", priority: 1 },
			{ id: "backup", priority: 2 },
		]
		// `backup` is faster and never fails, but it is not the account the operator chose.
		const ranked = rankByHealth(pool, (id) =>
			id === "backup" ? stats({ p95LatencyMs: 100 }) : stats({ p95LatencyMs: 5_000 }),
		)
		expect(ranked.map((account) => account.id)).toEqual(["primary", "backup"])
	})

	it("puts the healthier account first inside one tier", () => {
		const pool = [
			{ id: "slow", priority: 1 },
			{ id: "fast", priority: 1 },
		]
		const ranked = rankByHealth(pool, (id) =>
			id === "fast" ? stats({ p95LatencyMs: 200 }) : stats({ p95LatencyMs: 8_000 }),
		)
		expect(ranked.map((account) => account.id)).toEqual(["fast", "slow"])
	})

	it("keeps the caller's order when nothing is measured", () => {
		const pool = [
			{ id: "a", priority: 1 },
			{ id: "b", priority: 1 },
			{ id: "c", priority: 2 },
		]
		expect(rankByHealth(pool, () => null).map((account) => account.id)).toEqual(["a", "b", "c"])
	})

	it("treats a missing priority as the last tier", () => {
		const pool = [{ id: "explicit", priority: 5 }, { id: "implicit" }]
		expect(rankByHealth(pool, () => null).map((account) => account.id)).toEqual([
			"explicit",
			"implicit",
		])
	})

	it("returns a copy, never the caller's array", () => {
		const pool = [{ id: "a", priority: 1 }]
		const ranked = rankByHealth(pool, () => null)
		expect(ranked).not.toBe(pool)
	})
})
