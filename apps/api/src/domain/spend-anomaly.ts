/**
 * Spend anomalies: the hour that cost far more than the hours before it.
 *
 * The forecast answers "where is this heading" from an average, which is exactly the figure a
 * spike does not move: a key that spends 20x its usual rate for one hour barely shifts a
 * 30-day daily rate, and the projection that was safe at 09:00 still reads safe at 10:00. The
 * bill arrives later and the cause is gone by then. This module is the other question — "is
 * this hour unusual for this key" — asked per bucket, so the answer is available while the
 * traffic is still running.
 *
 * Four decisions, each one a way an anomaly detector becomes noise:
 *
 * 1. **Median and MAD, not mean and standard deviation.** One spike inflates the standard
 *    deviation enough to hide itself, so a detector built on it never fires on the event it
 *    exists for. The median is unmoved by up to half the history, and the median absolute
 *    deviation inherits that resistance.
 * 2. **A zero MAD is not "perfectly stable".** A key that spent exactly $0.01 every hour for a
 *    day has MAD 0, and a naive z-score divides by zero. The scale then falls back to a
 *    relative floor (a share of the median) so an hour at 100x still registers.
 * 3. **A floor in absolute money.** Without it every quiet key with a single expensive call
 *    produces a "spike" of one cent, and the alert channel is muted within a week. A bucket
 *    has to be both statistically unusual and materially expensive.
 * 4. **The current bucket is excluded from its own baseline.** Including it is the classic
 *    self-masking bug: a large enough spike drags the median toward itself until it looks
 *    normal.
 */

/** Buckets of history a baseline needs before it is allowed to accuse anything. */
export const ANOMALY_MIN_BASELINE = 12

/** How many robust deviations above the median an hour must sit. */
export const ANOMALY_Z_THRESHOLD = 3.5

/** The floor a bucket must also clear, in the same unit as the spend (dollars). */
export const ANOMALY_MIN_COST = 0.25

/** The multiple of the median used as the scale when MAD collapses to zero. */
const RELATIVE_SCALE_FLOOR = 0.5

/** One hour's spend for one key. */
export interface SpendBucket {
	/** The key the spend belongs to; `"*"` for the install-wide series. */
	readonly key: string
	/** The hour bucket, `YYYY-MM-DDTHH` in local time, ascending. */
	readonly hour: string
	readonly cost: number
}

export type AnomalySeverity = "warning" | "critical"

export interface SpendAnomaly {
	readonly key: string
	readonly hour: string
	/** What the hour actually cost. */
	readonly cost: number
	/** The baseline the hour was measured against (median of the prior buckets). */
	readonly baseline: number
	/** Robust deviations above the baseline. */
	readonly zScore: number
	/** How many times the baseline the hour reached. */
	readonly multiple: number
	readonly severity: AnomalySeverity
}

/** The median of a numeric series; `null` when empty. */
export function medianOf(values: readonly number[]): number | null {
	const clean = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
	if (clean.length === 0) return null
	const middle = Math.floor(clean.length / 2)
	if (clean.length % 2 === 1) return clean[middle] ?? null
	const lower = clean[middle - 1] ?? 0
	const upper = clean[middle] ?? 0
	return (lower + upper) / 2
}

/**
 * The median absolute deviation.
 *
 * Scaled by 1.4826 so it estimates the same quantity as a standard deviation on normal data —
 * which is what makes `ANOMALY_Z_THRESHOLD` readable as "about three and a half sigma" instead
 * of as an arbitrary constant.
 */
export function madOf(values: readonly number[]): number | null {
	const centre = medianOf(values)
	if (centre === null) return null
	const deviations = values
		.filter((value) => Number.isFinite(value))
		.map((value) => Math.abs(value - centre))
	return (medianOf(deviations) ?? 0) * 1.4826
}

/** The spread to divide by, falling back to a relative floor when MAD is zero. */
function scaleOf(baseline: number, mad: number): number {
	if (mad > 0) return mad
	// A perfectly regular key still has to be able to look spiky.
	return Math.max(Math.abs(baseline) * RELATIVE_SCALE_FLOOR, ANOMALY_MIN_COST)
}

function severityOf(multiple: number, zScore: number): AnomalySeverity {
	return multiple >= 10 || zScore >= ANOMALY_Z_THRESHOLD * 2 ? "critical" : "warning"
}

/**
 * Judge one bucket against the buckets before it.
 *
 * `null` means "not an anomaly" — including the case where there is not enough history to say,
 * which must never be reported as a spike. A detector that fires on its first observation
 * trains its reader to ignore it.
 */
export function judgeBucket(bucket: SpendBucket, history: readonly number[]): SpendAnomaly | null {
	if (!Number.isFinite(bucket.cost) || bucket.cost <= 0) return null
	if (history.length < ANOMALY_MIN_BASELINE) return null
	if (bucket.cost < ANOMALY_MIN_COST) return null

	const baseline = medianOf(history)
	if (baseline === null) return null
	const mad = madOf(history) ?? 0
	const scale = scaleOf(baseline, mad)
	const zScore = (bucket.cost - baseline) / scale
	if (zScore < ANOMALY_Z_THRESHOLD) return null

	const multiple = baseline > 0 ? bucket.cost / baseline : Number.POSITIVE_INFINITY
	return {
		key: bucket.key,
		hour: bucket.hour,
		cost: bucket.cost,
		baseline,
		zScore: Math.round(zScore * 100) / 100,
		multiple: Number.isFinite(multiple) ? Math.round(multiple * 100) / 100 : 0,
		severity: severityOf(Number.isFinite(multiple) ? multiple : 99, zScore),
	}
}

/**
 * Anomalies across a series of buckets, oldest first.
 *
 * Each bucket is judged against a *trailing* window, not the whole series: spend drifts
 * (a key gets busier every week), and a baseline built from the beginning of the month would
 * call a normal Tuesday in week four a spike.
 */
export function detectSpendAnomalies(
	buckets: readonly SpendBucket[],
	options: { readonly trailingBuckets?: number } = {},
): SpendAnomaly[] {
	const trailing = Math.max(ANOMALY_MIN_BASELINE, Math.trunc(options.trailingBuckets ?? 48))
	const byKey = new Map<string, SpendBucket[]>()
	for (const bucket of buckets) {
		const list = byKey.get(bucket.key)
		if (list) list.push(bucket)
		else byKey.set(bucket.key, [bucket])
	}

	const found: SpendAnomaly[] = []
	for (const series of byKey.values()) {
		const ordered = [...series].sort((a, b) => a.hour.localeCompare(b.hour))
		ordered.forEach((bucket, index) => {
			const window = ordered.slice(Math.max(0, index - trailing), index).map((row) => row.cost)
			const anomaly = judgeBucket(bucket, window)
			if (anomaly) found.push(anomaly)
		})
	}
	// Worst first: the reader has one alert budget, not one per key.
	return found.sort((a, b) => b.zScore - a.zScore || b.cost - a.cost)
}
