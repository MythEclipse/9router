/**
 * The Prometheus scrape, composed from read models that already exist.
 *
 * Every number here is already computed for the dashboard — per-model request/token/cost
 * totals from the leaderboard, and the spend projection from `spendForecast`. Nothing is
 * re-queried, so a scrape and the page beside it cannot disagree, and adding a metric cannot
 * quietly introduce a second definition of "spent".
 *
 * Two shapes the composition has to get right:
 *
 * - **Errors are derived, not counted.** The leaderboard carries `requests` and `successes`;
 *   `requests - successes` is clamped at zero because a success recorded without its request
 *   (an import, a replayed row) would otherwise emit a negative counter and make `rate()`
 *   produce nonsense.
 * - **One sample per label set.** A model served by two providers is two samples, not one
 *   merged row: Prometheus identifies a series by its labels, and two identical label sets are
 *   a duplicate-series error that fails the whole scrape.
 */
import { expositionDocument, type MetricSample } from "../../domain/prometheus.ts"
import type { LeaderboardEntry } from "../../domain/usage-derivations.ts"
import type { LatencyReportResult, LatencyReportUseCase } from "./latency-report.ts"
import type { UsageScope } from "./report-usage.ts"
import type { SpendForecastUseCase } from "./spend-forecast.ts"
import type { UsagePanels } from "./usage-panels.ts"

/** The exposition's own content type. Prometheus negotiates on this string. */
export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"

/**
 * The metric prefix.
 *
 * It cannot be `9router_`: the exposition format's first character must be a letter,
 * underscore or colon, so a name starting with a digit is rejected by every Prometheus —
 * `9router_up` fails the scrape, not just the linter. `nine_router_` is the same name spelled
 * legally.
 */
const PREFIX = "nine_router"

export interface MetricsExpositionDeps {
	readonly panels: Pick<UsagePanels, "leaderboard">
	readonly forecast: SpendForecastUseCase
	/**
	 * The latency report, as a use-case rather than a number.
	 *
	 * A scrape is pulled at a moment of the scraper's choosing, so the histogram has to be built
	 * from the same window rule the dashboard uses (`period`), not from a snapshot taken when
	 * the process started.
	 */
	readonly latency: LatencyReportUseCase
}

export interface MetricsExpositionResult {
	readonly period: string
	readonly body: string
	readonly contentType: string
}

export interface MetricsExposition {
	readonly exposition: (period: unknown, scope: UsageScope) => Promise<MetricsExpositionResult>
}

/** One model's samples, labelled by model and provider. */
function modelSamples(entry: LeaderboardEntry): MetricSample[] {
	const labels = { model: entry.model, provider: entry.provider || "unknown" }
	const errors = Math.max(0, entry.requests - entry.successes)
	return [
		{
			name: `${PREFIX}_requests_total`,
			type: "counter",
			help: "Requests served per model and provider, over the scrape period.",
			labels,
			value: entry.requests,
		},
		{
			name: `${PREFIX}_request_errors_total`,
			type: "counter",
			help: "Requests that did not succeed, per model and provider.",
			labels,
			value: errors,
		},
		{
			name: `${PREFIX}_tokens_total`,
			type: "counter",
			help: "Tokens billed per model and provider.",
			labels: { ...labels, kind: "input" },
			value: entry.promptTokens,
		},
		{
			name: `${PREFIX}_tokens_total`,
			type: "counter",
			help: "Tokens billed per model and provider.",
			labels: { ...labels, kind: "output" },
			value: entry.completionTokens,
		},
		{
			name: `${PREFIX}_spend_total`,
			type: "gauge",
			help: "Spend attributed to this model and provider, over the scrape period.",
			labels,
			value: entry.totalCost,
		},
	]
}

/**
 * The latency histogram, one family with per-provider series.
 *
 * A histogram rather than a p95 gauge alone: a gauge can only answer "how slow is it now", and
 * `histogram_quantile()` over buckets answers "how slow was it in any window you like" from
 * data already scraped. `_sum` is derived from the mean and the sample count because the report
 * does not carry the raw total — the buckets are what a percentile is computed from.
 */
function latencySamples(report: LatencyReportResult): MetricSample[] {
	const samples: MetricSample[] = []
	for (const group of report.report.byProvider) {
		const labels = { provider: group.key }
		for (const bucket of group.summary.histogram) {
			samples.push({
				name: `${PREFIX}_latency_ms_bucket`,
				family: `${PREFIX}_latency_ms`,
				type: "histogram",
				help: "Request duration in milliseconds, per provider, over the scrape period.",
				labels: { ...labels, le: bucket.le === null ? "+Inf" : String(bucket.le) },
				value: bucket.count,
			})
		}
		const mean = group.summary.mean ?? 0
		samples.push(
			{
				name: `${PREFIX}_latency_ms_sum`,
				family: `${PREFIX}_latency_ms`,
				type: "histogram",
				help: "Request duration in milliseconds, per provider, over the scrape period.",
				labels,
				value: mean * group.summary.samples,
			},
			{
				name: `${PREFIX}_latency_ms_count`,
				family: `${PREFIX}_latency_ms`,
				type: "histogram",
				help: "Request duration in milliseconds, per provider, over the scrape period.",
				labels,
				value: group.summary.samples,
			},
			{
				name: `${PREFIX}_latency_p95_ms`,
				type: "gauge",
				help: "95th percentile request duration per provider, as this gateway measured it.",
				labels,
				value: group.summary.p95 ?? 0,
			},
			{
				name: `${PREFIX}_ttft_p95_ms`,
				type: "gauge",
				help: "95th percentile time to first token per provider (streamed requests only).",
				labels,
				value: group.summary.ttftP95 ?? 0,
			},
		)
	}
	return samples
}

export function makeMetricsExposition(deps: MetricsExpositionDeps): MetricsExposition {
	return {
		async exposition(requestedPeriod: unknown, scope: UsageScope) {
			const { period, leaderboard } = (await deps.panels.leaderboard(requestedPeriod, scope)) as {
				readonly period: string
				readonly leaderboard: readonly LeaderboardEntry[]
			}
			// A projection without a cap: a scrape cannot know which budget to measure against,
			// and inventing one would report every install as exhausted.
			const { forecast } = await deps.forecast.forecast(requestedPeriod, scope, null)
			// The same window as the page beside it: a scrape and a dashboard that disagree
			// about "this week" are two definitions of the same word.
			const latency = await deps.latency.report(requestedPeriod, scope)

			const samples: MetricSample[] = [
				{
					name: `${PREFIX}_up`,
					type: "gauge",
					help: "1 when the gateway answered this scrape.",
					value: 1,
				},
				...leaderboard.flatMap(modelSamples),
				...latencySamples(latency),
				{
					name: `${PREFIX}_spend_observed`,
					type: "gauge",
					help: "Spend recorded in the scrape period, from the daily rollup.",
					labels: { period },
					value: forecast.observedSpend,
				},
				{
					name: `${PREFIX}_spend_daily_rate`,
					type: "gauge",
					help: "Cost per day at the current rate, with today extrapolated.",
					labels: { period, confidence: forecast.confidence },
					value: forecast.dailyRate,
				},
				{
					name: `${PREFIX}_spend_projected`,
					type: "gauge",
					help: "Spend projected for the whole period at the current rate.",
					labels: { period, confidence: forecast.confidence },
					value: forecast.projectedTotal,
				},
			]

			return {
				period,
				body: expositionDocument(samples),
				contentType: PROMETHEUS_CONTENT_TYPE,
			}
		},
	}
}
