import {
	ANOMALY_MIN_BASELINE,
	ANOMALY_MIN_COST,
	detectSpendAnomalies,
	judgeBucket,
	madOf,
	medianOf,
} from "9router-api/domain/spend-anomaly"
import { describe, expect, it } from "vitest"

/** A series of hourly costs, one key, oldest first. */
const series = (costs: number[], key = "k1") =>
	costs.map((cost, index) => ({
		key,
		hour: `2026-01-01T${String(index).padStart(2, "0")}`,
		cost,
	}))

/** A flat baseline long enough to be allowed to accuse anything. */
const baseline = (cost: number, count = ANOMALY_MIN_BASELINE) =>
	Array.from({ length: count }, () => cost)

describe("medianOf", () => {
	it("is unmoved by a single extreme value", () => {
		expect(medianOf([1, 1, 1, 1, 1_000])).toBe(1)
	})

	it("averages the middle pair on an even count", () => {
		expect(medianOf([1, 2, 3, 4])).toBe(2.5)
	})

	it("answers null for an empty series", () => {
		expect(medianOf([])).toBeNull()
	})
})

describe("madOf", () => {
	it("is zero for a perfectly regular series", () => {
		expect(madOf([5, 5, 5, 5])).toBe(0)
	})

	it("scales like a standard deviation on a spread series", () => {
		expect(madOf([1, 2, 3, 4, 5])).toBeCloseTo(1.4826, 4)
	})
})

describe("judgeBucket", () => {
	it("refuses to accuse without enough history", () => {
		expect(judgeBucket({ key: "k", hour: "h", cost: 100 }, [1, 1, 1])).toBeNull()
	})

	it("ignores a spike below the absolute floor", () => {
		const tiny = ANOMALY_MIN_COST / 2
		expect(judgeBucket({ key: "k", hour: "h", cost: tiny }, baseline(tiny / 50))).toBeNull()
	})

	it("fires on a large hour against a flat baseline", () => {
		const anomaly = judgeBucket({ key: "k", hour: "h", cost: 50 }, baseline(1))
		expect(anomaly).not.toBeNull()
		expect(anomaly?.multiple).toBe(50)
		expect(anomaly?.severity).toBe("critical")
	})

	it("still fires when the baseline deviation collapses to zero", () => {
		// MAD is 0 here; the relative floor is what keeps the division meaningful.
		const anomaly = judgeBucket({ key: "k", hour: "h", cost: 10 }, baseline(1))
		expect(anomaly).not.toBeNull()
		expect(anomaly?.zScore).toBeGreaterThan(3.5)
	})

	it("is not fooled by its own spike in the baseline", () => {
		// The trailing window excludes the bucket being judged, so a huge value cannot drag the
		// median toward itself and look normal.
		const anomalies = detectSpendAnomalies(series([...baseline(1), 100]))
		expect(anomalies).toHaveLength(1)
		expect(anomalies[0]?.cost).toBe(100)
	})

	it("does not fire on ordinary variation", () => {
		const anomalies = detectSpendAnomalies(
			series([1, 1.2, 0.8, 1.1, 0.9, 1, 1.05, 0.95, 1, 1, 1, 1, 1.1]),
		)
		expect(anomalies).toEqual([])
	})
})

describe("detectSpendAnomalies", () => {
	it("judges each key against its own baseline", () => {
		const anomalies = detectSpendAnomalies([
			...series(baseline(1), "quiet"),
			...series([...baseline(10), 100], "busy"),
		])
		expect(anomalies).toHaveLength(1)
		expect(anomalies[0]?.key).toBe("busy")
	})

	it("reports the worst deviation first", () => {
		const anomalies = detectSpendAnomalies([
			...series([...baseline(1), 20], "a"),
			...series([...baseline(1), 200], "b"),
		])
		expect(anomalies.map((anomaly) => anomaly.key)).toEqual(["b", "a"])
	})

	it("keeps a trailing window, so month-old drift is not a spike", () => {
		// A key that doubled its spend a month ago and has been steady since: the trailing
		// window sees the new level, not the old one.
		const steadyOld = baseline(1, 30)
		const steadyNew = baseline(2, 48)
		const anomalies = detectSpendAnomalies(series([...steadyOld, ...steadyNew]), {
			trailingBuckets: 48,
		})
		expect(anomalies).toEqual([])
	})
})
