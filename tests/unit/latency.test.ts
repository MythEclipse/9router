import {
	buildLatencyReport,
	histogramBuckets,
	LATENCY_BUCKETS_MS,
	LATENCY_MIN_SAMPLES,
	percentile,
	summariseDurations,
	summariseMeasurements,
} from "9router-api/domain/latency"
import { describe, expect, it } from "vitest"

const measurement = (
	overrides: Partial<Parameters<typeof summariseMeasurements>[0][number]> = {},
) => ({
	provider: "openai",
	model: "gpt-4o",
	latencyMs: 100,
	ttftMs: 40,
	cached: false,
	...overrides,
})

describe("percentile", () => {
	it("answers the nearest rank, an actual observation", () => {
		// 20 values: p95 is the 19th (index 18), not an interpolation between 18 and 19.
		const values = Array.from({ length: 20 }, (_, index) => (index + 1) * 10)
		expect(percentile(values, 0.95)).toBe(190)
		expect(percentile(values, 0.5)).toBe(100)
		expect(percentile(values, 1)).toBe(200)
	})

	it("answers null for an empty series rather than zero", () => {
		expect(percentile([], 0.95)).toBeNull()
	})

	it("ignores values that are not durations", () => {
		expect(percentile([Number.NaN, -5, 100], 0.5)).toBe(100)
	})

	it("clamps a percentile outside the unit interval", () => {
		expect(percentile([10, 20, 30], 0)).toBe(10)
		expect(percentile([10, 20, 30], 5)).toBe(30)
	})
})

describe("summariseDurations", () => {
	it("reports the mean beside the percentiles, not instead of them", () => {
		const summary = summariseDurations([100, 100, 100, 100, 9_000])
		expect(summary.p50).toBe(100)
		expect(summary.mean).toBe(1_880)
	})

	it("marks a small sample as unreliable", () => {
		const summary = summariseDurations([100, 200])
		expect(summary.reliable).toBe(false)
		expect(summary.samples).toBe(2)
	})

	it("is reliable at the documented sample floor", () => {
		const values = Array.from({ length: LATENCY_MIN_SAMPLES }, () => 100)
		expect(summariseDurations(values).reliable).toBe(true)
	})

	it("answers an empty summary when there is nothing to summarise", () => {
		const summary = summariseDurations([])
		expect(summary.samples).toBe(0)
		expect(summary.p95).toBeNull()
		expect(summary.mean).toBeNull()
	})
})

describe("summariseMeasurements", () => {
	it("excludes a non-streamed request from the first-token percentile", () => {
		const summary = summariseMeasurements([
			measurement({ ttftMs: 100 }),
			measurement({ ttftMs: null }),
			measurement({ ttftMs: null }),
		])
		expect(summary.ttftSamples).toBe(1)
		expect(summary.ttftP50).toBe(100)
	})

	it("counts cached answers separately from the rest", () => {
		const summary = summariseMeasurements([
			measurement({ cached: true, latencyMs: 2 }),
			measurement({ latencyMs: 800 }),
		])
		expect(summary.cachedSamples).toBe(1)
		expect(summary.samples).toBe(2)
	})
})

describe("histogramBuckets", () => {
	it("is cumulative and always ends with +Inf", () => {
		const buckets = histogramBuckets([40, 400, 4_000], [100, 1_000])
		expect(buckets).toEqual([
			{ le: 100, count: 1 },
			{ le: 1_000, count: 2 },
			{ le: null, count: 3 },
		])
	})

	it("counts every request in the +Inf bucket even when nothing fits a bound", () => {
		const buckets = histogramBuckets([120_000], LATENCY_BUCKETS_MS)
		const last = buckets[buckets.length - 1]
		expect(last).toEqual({ le: null, count: 1 })
		expect(buckets[0]).toEqual({ le: LATENCY_BUCKETS_MS[0], count: 0 })
	})
})

describe("buildLatencyReport", () => {
	it("groups by provider and model, slowest p95 first", () => {
		const report = buildLatencyReport([
			measurement({ provider: "fast", model: "a", latencyMs: 100 }),
			measurement({ provider: "slow", model: "b", latencyMs: 9_000 }),
			measurement({ provider: "slow", model: "b", latencyMs: 9_000 }),
		])
		expect(report.byProvider.map((group) => group.key)).toEqual(["slow", "fast"])
		expect(report.byProvider[0]?.summary.samples).toBe(2)
		expect(report.overall.samples).toBe(3)
	})

	it("skips measurements that carry no provider or model when grouping", () => {
		const report = buildLatencyReport([
			measurement({ provider: null }),
			measurement({ model: null, provider: "only-provider" }),
		])
		// A row with no provider cannot be attributed to one, but it still happened.
		expect(report.byProvider.map((group) => group.key)).toEqual(["only-provider"])
		expect(report.byModel.map((group) => group.key)).toEqual(["gpt-4o"])
		expect(report.overall.samples).toBe(2)
	})
})
