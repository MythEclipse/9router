import { describe, expect, it } from "vitest"
import {
	compareKeyReportRows,
	errorRateOf,
	KEY_REPORT_MODEL_LIMIT,
	mergeOrphanUsage,
	nextResetAt,
	percentOfCap,
	quotaWindowStart,
	resetIntervalMs,
	resolvedUsedTokens,
	shouldReportOrphanUsage,
} from "../../apps/api/src/domain/key-usage-report.ts"

const HOUR = 3_600_000
const NOW = new Date("2026-10-29T12:00:00.000Z").getTime()

describe("resetIntervalMs", () => {
	it("knows each interval the CLI key editor offers", () => {
		expect(resetIntervalMs("5h")).toBe(5 * HOUR)
		expect(resetIntervalMs("1d")).toBe(24 * HOUR)
		expect(resetIntervalMs("30d")).toBe(30 * 24 * HOUR)
	})

	it("treats never and unknown values as open-ended", () => {
		// An unknown interval must not be read as "resets now", which would zero the count.
		expect(resetIntervalMs("never")).toBe(0)
		expect(resetIntervalMs("3w")).toBe(0)
		expect(resetIntervalMs(undefined)).toBe(0)
	})
})

describe("quotaWindowStart", () => {
	it("counts back one interval", () => {
		expect(quotaWindowStart("5h", NOW)).toBe(new Date(NOW - 5 * HOUR).toISOString())
	})

	it("counts everything for an open-ended interval", () => {
		expect(quotaWindowStart("never", NOW)).toBe("0000-01-01T00:00:00.000Z")
	})
})

describe("nextResetAt", () => {
	it("steps forward past now for a key idle for several windows", () => {
		// anchor + span alone lands in the past for an idle key.
		const anchor = new Date(NOW - 3 * 7 * 24 * HOUR).toISOString()
		const due = nextResetAt("7d", anchor, NOW)
		expect(due).not.toBe(null)
		expect(new Date(due as string).getTime()).toBeGreaterThan(NOW)
	})

	it("returns null for an interval that never resets", () => {
		expect(nextResetAt("never", new Date(NOW).toISOString(), NOW)).toBe(null)
	})

	it("returns null when the key has never reset", () => {
		// Inventing now + span would show a countdown for a window that never started.
		expect(nextResetAt("7d", null, NOW)).toBe(null)
		expect(nextResetAt("7d", "not a date", NOW)).toBe(null)
	})

	it("uses the next multiple of the interval, not a drifting offset", () => {
		const anchor = new Date(NOW - 2 * 24 * HOUR).toISOString()
		const due = new Date(nextResetAt("1d", anchor, NOW) as string).getTime()
		expect(due - new Date(anchor).getTime()).toBe(3 * 24 * HOUR)
	})
})

describe("resolvedUsedTokens", () => {
	it("trusts the column when the pruned log reads lower", () => {
		// usageHistory is pruned, so the log sum can understate real spend.
		expect(resolvedUsedTokens({ columnValue: 900, windowSum: 400 })).toEqual({
			used: 900,
			source: "column",
		})
	})

	it("trusts the log when rows raced in ahead of the quota update", () => {
		expect(resolvedUsedTokens({ columnValue: 100, windowSum: 250 })).toEqual({
			used: 250,
			source: "window",
		})
	})

	it("handles nulls and garbage without producing NaN", () => {
		expect(resolvedUsedTokens({ columnValue: null, windowSum: null })).toEqual({
			used: 0,
			source: "equal",
		})
		expect(resolvedUsedTokens({ columnValue: "abc", windowSum: 5 }).used).toBe(5)
	})
})

describe("mergeOrphanUsage", () => {
	const totals = {
		k1: { requests: 10, promptTokens: 100, completionTokens: 50, cost: 0.5, lastUsed: "2026-10-01" },
		k2: { requests: 5, promptTokens: 20, completionTokens: 10, cost: 0.25, lastUsed: "2026-10-03" },
	}
	const statuses = { k1: { ok: 8, errors: 2 }, k2: { ok: 5, errors: 0 } }
	const models = {
		k1: [{ model: "gpt-5", requests: 10, tokens: 150, cost: 0.5, lastUsed: "2026-10-01" }],
		k2: [
			{ model: "gpt-5", requests: 4, tokens: 30, cost: 0.2, lastUsed: "2026-10-03" },
			{ model: "claude", requests: 1, tokens: 5, cost: 0.05, lastUsed: "2026-10-02" },
		],
	}

	it("sums every deleted key into one row", () => {
		const merged = mergeOrphanUsage(["k1", "k2"], totals, statuses, models)
		expect(merged.requests).toBe(15)
		expect(merged.promptTokens).toBe(120)
		expect(merged.completionTokens).toBe(60)
		expect(merged.cost).toBeCloseTo(0.75)
	})

	it("keeps the newest lastUsed across the merged keys", () => {
		expect(mergeOrphanUsage(["k1", "k2"], totals, statuses, models).lastUsed).toBe("2026-10-03")
	})

	it("merges the same model across keys instead of listing it twice", () => {
		const merged = mergeOrphanUsage(["k1", "k2"], totals, statuses, models)
		const gpt = merged.models.find((row) => row.model === "gpt-5")
		expect(merged.models.filter((row) => row.model === "gpt-5")).toHaveLength(1)
		expect(gpt).toMatchObject({ requests: 14, tokens: 180 })
	})

	it("orders models by request count and keeps the panel limit", () => {
		const many = Object.fromEntries(
			Array.from({ length: 20 }, (_, index) => [
				`m${index}`,
				[{ model: `model-${index}`, requests: index, tokens: 1, cost: 0, lastUsed: null }],
			]),
		)
		// The orphan keys must be the ones the model rows are filed under.
		const merged = mergeOrphanUsage(Object.keys(many), {}, {}, many)
		expect(merged.models).toHaveLength(KEY_REPORT_MODEL_LIMIT)
		expect(merged.models[0]?.model).toBe("model-19")
	})

	it("survives a key that has totals but no model or status rows", () => {
		const merged = mergeOrphanUsage(["k1"], totals, {}, {})
		expect(merged).toMatchObject({ requests: 10, ok: 0, errors: 0, models: [] })
	})
})

describe("shouldReportOrphanUsage", () => {
	it("reports deleted keys only for a full listing", () => {
		expect(shouldReportOrphanUsage(null)).toBe(true)
	})

	it("hides them from an API-key session, whose unseen keys are not deleted", () => {
		// Calling another branch's traffic "deleted" would invite deleting it.
		expect(shouldReportOrphanUsage("sk-abc")).toBe(false)
	})
})

describe("percentOfCap", () => {
	it("returns null when there is no cap", () => {
		expect(percentOfCap(50, 0)).toBe(null)
		expect(percentOfCap(50, -1)).toBe(null)
	})

	it("caps at 100 so an overrun does not render as 140%", () => {
		expect(percentOfCap(150, 100)).toBe(100)
		expect(percentOfCap(25, 100)).toBe(25)
	})
})

describe("errorRateOf", () => {
	it("is a fraction of all requests", () => {
		expect(errorRateOf(90, 10)).toBeCloseTo(0.1)
	})

	it("is zero for a key with no traffic rather than NaN", () => {
		expect(errorRateOf(0, 0)).toBe(0)
	})
})

describe("compareKeyReportRows", () => {
	it("puts the most recently used first", () => {
		const rows = [
			{ lastUsed: "2026-10-01", name: "old" },
			{ lastUsed: "2026-10-05", name: "new" },
		]
		expect(rows.sort(compareKeyReportRows).map((r) => r.name)).toEqual(["new", "old"])
	})

	it("breaks ties by name so the table does not reshuffle between polls", () => {
		const rows = [
			{ lastUsed: null, name: "zeta" },
			{ lastUsed: null, name: "alpha" },
		]
		expect(rows.sort(compareKeyReportRows).map((r) => r.name)).toEqual(["alpha", "zeta"])
	})
})
