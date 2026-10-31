/**
 * Adapters for the two observability use-cases: the latency report and the spend-anomaly
 * detector.
 *
 * Both read `usageHistory` through `@9router/db` — the same table the usage page reads, so a
 * panel and a percentile cannot disagree about what happened. Nothing here decides anything:
 * the percentiles and the anomaly thresholds live in `domain/`, and this file only narrows the
 * untyped rows.
 *
 * The anomaly detector also needs a writer, because a spike has to leave the box: it files a
 * notice in the notification feed, and the existing alert dispatch carries it to whatever
 * channel the operator configured. Writing through the feed rather than calling a webhook here
 * is what keeps the delivery rules (dedupe, retry, one marker per send) in one place.
 */
import { getHourlySpend, getLatencySamples } from "@9router/db/index"
import { notify } from "@9router/db/repos/notificationsRepo"
import type { LatencySamplePort } from "../../../application/usage/latency-report.ts"
import type { SpendAnomalyPorts } from "../../../application/usage/spend-anomaly.ts"

export function createLatencySamplePort(): LatencySamplePort {
	return {
		async samples(request) {
			const rows = await getLatencySamples({
				since: request.since,
				apiKey: request.apiKey,
				allowedModels: request.allowedModels,
				limit: request.limit,
			})
			return rows.map((row) => ({
				timestamp: row.timestamp,
				provider: row.provider,
				model: row.model,
				latencyMs: row.latencyMs,
				ttftMs: row.ttftMs,
				cached: row.cached,
			}))
		},
	}
}

export function createSpendAnomalyPorts(): SpendAnomalyPorts {
	return {
		async hourlySpend(query) {
			return getHourlySpend({
				since: query.since,
				apiKey: query.apiKey,
				allowedModels: query.allowedModels,
			})
		},

		async raise(notice) {
			await notify({
				kind: notice.kind,
				severity: notice.severity,
				title: notice.title,
				body: notice.body,
				link: notice.link,
				// The store prefixes the kind itself; the rest identifies the condition, so a
				// re-run refreshes one notice instead of stacking a second.
				dedupeKey: notice.dedupeKey,
			})
		},
	}
}
