/**
 * The spend-anomaly use-case: read hourly spend, judge it, and (optionally) raise a notice.
 *
 * Two questions, deliberately separate:
 *
 *  - `detect` answers what looks unusual in the window. It writes nothing, so the dashboard can
 *    call it on every poll.
 *  - `raise` turns those findings into notifications in the existing feed. Writing only on an
 *    explicit call is what keeps a detector from filling the bell on every refresh: the feed
 *    dedupes by `(kind, key, hour)`, so a repeat is a refresh of one notice rather than a
 *    second one — but a detector that writes on every read still turns every page load into a
 *    write.
 *
 * The window is at least 24 hours even when the caller asks for less, because a baseline needs
 * history: `ANOMALY_MIN_BASELINE` buckets of trailing data. Asking for `today` and being told
 * "nothing unusual" at 09:00 would be an answer about four hours of data, which is not enough
 * to accuse an hour of anything.
 */
import { AppError } from "../../domain/errors.ts"
import {
	DEFAULT_PERIOD,
	isPeriodRefused,
	periodCutoff,
	type ReportingPeriod,
	resolvePeriod,
} from "../../domain/reporting-period.ts"
import {
	detectSpendAnomalies,
	type SpendAnomaly,
	type SpendBucket,
} from "../../domain/spend-anomaly.ts"
import type { UsageScope } from "./report-usage.ts"

/** The shortest window a detector may look at. */
const MIN_WINDOW_MS = 86_400_000

/** How many trailing buckets form the baseline for one hour. */
const TRAILING_BUCKETS = 48

/** One hour of spend as the store returns it. */
export interface HourlySpendSample {
	readonly key: string
	readonly hour: string
	readonly cost: number
}

export interface SpendAnomalyPorts {
	readonly hourlySpend: (query: {
		readonly since: string
		readonly apiKey: string | null
		readonly allowedModels: string
	}) => Promise<readonly HourlySpendSample[]>
	/** Record a notice in the notification feed (deduped by the store). */
	readonly raise: (notice: {
		readonly kind: string
		readonly severity: string
		readonly title: string
		readonly body: string
		readonly link: string | null
		readonly dedupeKey: string
	}) => Promise<void>
}

/** The notice kind anomalies are filed under. */
export const SPEND_ANOMALY_KIND = "spend_anomaly"

export interface SpendAnomalyResult {
	readonly period: ReportingPeriod
	readonly since: string
	readonly anomalies: readonly SpendAnomaly[]
	readonly keysScanned: number
}

export interface SpendAnomalyRaiseResult extends SpendAnomalyResult {
	readonly raised: number
}

export interface SpendAnomalyUseCase {
	readonly detect: (period: unknown, scope: UsageScope, now?: Date) => Promise<SpendAnomalyResult>
	readonly raise: (
		period: unknown,
		scope: UsageScope,
		now?: Date,
	) => Promise<SpendAnomalyRaiseResult>
}

/** A money figure as it reads in a notice: cents below a dollar, two decimals above. */
function money(value: number): string {
	return value < 1 ? `$${value.toFixed(3)}` : `$${value.toFixed(2)}`
}

function noticeOf(anomaly: SpendAnomaly): {
	kind: string
	severity: string
	title: string
	body: string
	link: string | null
	dedupeKey: string
} {
	const keyName = anomaly.key === "*" ? "the install" : `key ${anomaly.key.slice(0, 8)}…`
	return {
		kind: SPEND_ANOMALY_KIND,
		severity: anomaly.severity,
		title: `Spend spike: ${money(anomaly.cost)} in one hour`,
		body:
			`${keyName} spent ${money(anomaly.cost)} at ${anomaly.hour}, against a usual ` +
			`${money(anomaly.baseline)} (${anomaly.multiple}x, ${anomaly.zScore} robust deviations).`,
		link: "/dashboard/usage",
		// One notice per key per hour: a re-run refreshes it rather than stacking.
		dedupeKey: `${anomaly.key}:${anomaly.hour}`,
	}
}

export function makeSpendAnomalies(ports: SpendAnomalyPorts): SpendAnomalyUseCase {
	async function read(
		requestedPeriod: unknown,
		scope: UsageScope,
		now: Date,
	): Promise<SpendAnomalyResult> {
		const resolved = resolvePeriod(requestedPeriod, DEFAULT_PERIOD)
		if (isPeriodRefused(resolved)) {
			throw new AppError("VALIDATION", resolved.message, { status: 400 })
		}
		const cutoff = periodCutoff(resolved.period, now)
		const since = cutoff === null ? new Date(now.getTime() - MIN_WINDOW_MS).toISOString() : cutoff
		const widened =
			new Date(since).getTime() > now.getTime() - MIN_WINDOW_MS
				? new Date(now.getTime() - MIN_WINDOW_MS).toISOString()
				: since

		const rows = await ports.hourlySpend({
			since: widened,
			apiKey: scope.apiKeyFilter,
			allowedModels: scope.allowedModels,
		})
		const buckets: SpendBucket[] = rows.map((row) => ({
			key: row.key,
			hour: row.hour,
			cost: row.cost,
		}))
		const keysScanned = new Set(buckets.map((bucket) => bucket.key)).size

		return {
			period: resolved.period,
			since: widened,
			anomalies: detectSpendAnomalies(buckets, { trailingBuckets: TRAILING_BUCKETS }),
			keysScanned,
		}
	}

	return {
		detect: (requestedPeriod, scope, now = new Date()) => read(requestedPeriod, scope, now),

		async raise(requestedPeriod, scope, now = new Date()) {
			const result = await read(requestedPeriod, scope, now)
			let raised = 0
			for (const anomaly of result.anomalies) {
				try {
					await ports.raise(noticeOf(anomaly))
					raised += 1
				} catch (error) {
					// One unusable notice must not swallow the rest of the findings.
					console.error(
						"[anomaly] failed to raise a spend notice:",
						error instanceof Error ? error.message : error,
					)
				}
			}
			return { ...result, raised }
		},
	}
}
