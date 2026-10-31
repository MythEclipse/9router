/**
 * Latency, as a number worth acting on.
 *
 * The gateway has always measured its own requests — `streamingHandler` stamps the first token
 * and the last — but the figures only ever reached a JSON blob that is pruned, so every
 * question about speed ("is this provider slow today", "which account should this request go
 * to") had no answer older than a few days. This module is the arithmetic those questions
 * need, kept free of storage so it can be tested against a table of numbers.
 *
 * Four decisions are baked in here, each of them a way a percentile report lies:
 *
 * 1. **Nearest-rank, not interpolation.** With 20 samples, p95 is the 19th value — an actual
 *    request. Interpolating between the 19th and 20th invents a duration nothing experienced,
 *    and a latency SLO is a statement about requests, not about a curve.
 * 2. **A missing measurement is not a zero.** `ttftMs` is `null` for a non-streamed answer,
 *    and `null` samples are excluded rather than averaged in. Counting them as zero would
 *    report a provider that answers instantly when it simply does not stream.
 * 3. **`mean` is reported beside the percentiles, never instead of them.** One hung request
 *    drags a mean by seconds; it moves p50 by nothing. Both numbers are shown so the reader
 *    can tell a slow tail from a slow service.
 * 4. **Small samples are labelled, not hidden.** Two requests can produce a p95 that looks
 *    authoritative. Below `LATENCY_MIN_SAMPLES` the summary says so, and the caller renders
 *    the number as provisional instead of ranking providers on noise.
 */

/** Measurements below this count are reported as provisional. */
export const LATENCY_MIN_SAMPLES = 20

/**
 * The histogram bounds, in milliseconds.
 *
 * Chosen so the interesting region is resolved finely (a streamed answer usually starts
 * between 200 ms and 2 s) while the tail stays bounded: the last bucket is `+Inf`, which the
 * exposition emits explicitly.
 */
export const LATENCY_BUCKETS_MS: readonly number[] = [
	50, 100, 250, 500, 1_000, 2_000, 5_000, 10_000, 30_000, 60_000,
]

/** One timed request, as the store hands it over. */
export interface LatencyMeasurement {
	readonly provider: string | null
	readonly model: string | null
	readonly latencyMs: number
	/** `null` when the answer was not streamed. */
	readonly ttftMs: number | null
	readonly cached: boolean
}

/** What a set of durations says. Every field is `null` when there is nothing to say. */
export interface LatencySummary {
	readonly samples: number
	readonly p50: number | null
	readonly p90: number | null
	readonly p95: number | null
	readonly p99: number | null
	readonly mean: number | null
	readonly min: number | null
	readonly max: number | null
	/** Streamed requests that carried a first-token time. */
	readonly ttftSamples: number
	readonly ttftP50: number | null
	readonly ttftP95: number | null
	/** Requests answered from the prompt cache, whose durations are near zero by design. */
	readonly cachedSamples: number
	/** `false` while the sample is too small to rank anything by. */
	readonly reliable: boolean
	/** Cumulative duration buckets, for the scrape and the distribution chart. */
	readonly histogram: readonly HistogramBucket[]
}

/** A named group of measurements (one provider, one model, or the whole window). */
export interface LatencyGroup {
	readonly key: string
	readonly summary: LatencySummary
}

export interface LatencyReport {
	readonly overall: LatencySummary
	readonly byProvider: readonly LatencyGroup[]
	readonly byModel: readonly LatencyGroup[]
}

/** Durations that can be summarised: finite and non-negative. */
function usable(value: number): boolean {
	return Number.isFinite(value) && value >= 0
}

/**
 * The p-th percentile of an ascending series, by nearest rank.
 *
 * `p` is a fraction in `(0, 1]`. An empty series answers `null` rather than `0`: zero is a
 * duration, and "no data" must not read like "instant".
 */
export function percentile(sortedAscending: readonly number[], p: number): number | null {
	const values = sortedAscending.filter(usable)
	if (values.length === 0) return null
	const clamped = Math.min(1, Math.max(0, p))
	// Nearest rank: the smallest index whose cumulative share reaches p.
	const rank = Math.ceil(clamped * values.length)
	return values[Math.min(values.length - 1, Math.max(0, rank - 1))] ?? null
}

function rounded(value: number | null): number | null {
	return value === null ? null : Math.round(value)
}

/**
 * Summarise a set of durations.
 *
 * The durations are sorted once here; every percentile reads that one array, so a report
 * cannot compute p50 and p95 from differently-filtered copies of the same data.
 */
export function summariseDurations(values: readonly number[]): LatencySummary {
	const clean = values.filter(usable).sort((a, b) => a - b)
	if (clean.length === 0) return emptySummary()
	const total = clean.reduce((sum, value) => sum + value, 0)
	return {
		samples: clean.length,
		p50: rounded(percentile(clean, 0.5)),
		p90: rounded(percentile(clean, 0.9)),
		p95: rounded(percentile(clean, 0.95)),
		p99: rounded(percentile(clean, 0.99)),
		mean: Math.round(total / clean.length),
		min: rounded(clean[0] ?? null),
		max: rounded(clean[clean.length - 1] ?? null),
		ttftSamples: 0,
		ttftP50: null,
		ttftP95: null,
		cachedSamples: 0,
		reliable: clean.length >= LATENCY_MIN_SAMPLES,
		histogram: histogramBuckets(clean),
	}
}

function emptySummary(): LatencySummary {
	return {
		samples: 0,
		p50: null,
		p90: null,
		p95: null,
		p99: null,
		mean: null,
		min: null,
		max: null,
		ttftSamples: 0,
		ttftP50: null,
		ttftP95: null,
		cachedSamples: 0,
		reliable: false,
		histogram: histogramBuckets([]),
	}
}

/**
 * The full summary of one group: durations, first-token times, and how much of it was cached.
 *
 * Cached answers are summarised with everything else but counted separately, because their
 * duration measures a database read, not the provider. A reader who wants "how fast is this
 * provider" subtracts them; a reader who wants "how fast is this endpoint" does not.
 */
export function summariseMeasurements(measurements: readonly LatencyMeasurement[]): LatencySummary {
	const durations = measurements.map((m) => m.latencyMs).filter(usable)
	const base = summariseDurations(durations)
	if (base.samples === 0) return base

	const ttfts = measurements
		.map((m) => m.ttftMs)
		.filter((value): value is number => value !== null && usable(value))
		.sort((a, b) => a - b)

	return {
		...base,
		ttftSamples: ttfts.length,
		ttftP50: rounded(percentile(ttfts, 0.5)),
		ttftP95: rounded(percentile(ttfts, 0.95)),
		cachedSamples: measurements.filter((m) => m.cached).length,
	}
}

/** Group measurements by a key, skipping the ones with no key at all. */
function groupBy(
	measurements: readonly LatencyMeasurement[],
	keyOf: (measurement: LatencyMeasurement) => string | null,
): LatencyGroup[] {
	const groups = new Map<string, LatencyMeasurement[]>()
	for (const measurement of measurements) {
		const key = keyOf(measurement)
		if (!key) continue
		const bucket = groups.get(key)
		if (bucket) bucket.push(measurement)
		else groups.set(key, [measurement])
	}
	return (
		[...groups.entries()]
			.map(([key, rows]) => ({ key, summary: summariseMeasurements(rows) }))
			// Slowest p95 first: the report exists to answer "which one is the problem".
			.sort((a, b) => (b.summary.p95 ?? -1) - (a.summary.p95 ?? -1) || a.key.localeCompare(b.key))
	)
}

/** The whole report: the window, then the same measurements split two ways. */
export function buildLatencyReport(measurements: readonly LatencyMeasurement[]): LatencyReport {
	return {
		overall: summariseMeasurements(measurements),
		byProvider: groupBy(measurements, (m) => m.provider),
		byModel: groupBy(measurements, (m) => m.model),
	}
}

/** One cumulative bucket of a histogram. */
export interface HistogramBucket {
	/** Upper bound in milliseconds, or `null` for the `+Inf` bucket. */
	readonly le: number | null
	/** How many measurements are at or below `le`. */
	readonly count: number
}

/**
 * Cumulative counts for a Prometheus histogram.
 *
 * The `+Inf` bucket is always present and always equals the sample count — a histogram
 * without it cannot be summed, and Prometheus rejects the family.
 */
export function histogramBuckets(
	values: readonly number[],
	bounds: readonly number[] = LATENCY_BUCKETS_MS,
): HistogramBucket[] {
	const clean = values.filter(usable)
	const buckets = bounds.map((le) => ({ le, count: clean.filter((value) => value <= le).length }))
	return [...buckets, { le: null, count: clean.length }]
}
