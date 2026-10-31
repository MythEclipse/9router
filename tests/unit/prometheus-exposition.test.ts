/**
 * The Prometheus exposition, and the scrape's composition.
 *
 * These tests exist because every failure mode here is silent in production: an unescaped
 * quote fails the whole scrape (which reads as "9router is down" in Grafana), a repeated
 * `# HELP` is rejected, `String(Infinity)` is not a value the format defines, and a duplicate
 * label set is a duplicate-series error. None of those throw anywhere we would notice.
 */

import {
	makeMetricsExposition,
	PROMETHEUS_CONTENT_TYPE,
} from "9router-api/application/usage/metrics-exposition"
import {
	escapeLabelValue,
	expositionDocument,
	formatMetricValue,
	type MetricSample,
} from "9router-api/domain/prometheus"
import { describe, expect, it } from "vitest"

const sample = (over: Partial<MetricSample> = {}): MetricSample => ({
	name: "nine_router_up",
	type: "gauge",
	help: "1 when the gateway answered.",
	value: 1,
	...over,
})

describe("escapeLabelValue", () => {
	it("escapes the three characters the format reserves", () => {
		expect(escapeLabelValue('a"b')).toBe('a\\"b')
		expect(escapeLabelValue("a\\b")).toBe("a\\\\b")
		expect(escapeLabelValue("a\nb")).toBe("a\\nb")
	})

	it("leaves an ordinary model name alone", () => {
		expect(escapeLabelValue("claude-sonnet-4.5")).toBe("claude-sonnet-4.5")
	})
})

describe("formatMetricValue", () => {
	it("spells the non-finite values the way the format defines them", () => {
		// `String(Infinity)` is "Infinity", which the text format does not define: one
		// zero-rate average would otherwise fail the entire scrape.
		expect(formatMetricValue(Number.POSITIVE_INFINITY)).toBe("+Inf")
		expect(formatMetricValue(Number.NEGATIVE_INFINITY)).toBe("-Inf")
		expect(formatMetricValue(Number.NaN)).toBe("NaN")
	})

	it("prints integers without a decimal tail", () => {
		expect(formatMetricValue(42)).toBe("42")
		expect(formatMetricValue(0)).toBe("0")
	})

	it("rounds float noise, so two scrapes of one sum are byte-identical", () => {
		expect(formatMetricValue(0.1 + 0.2)).toBe("0.3")
		expect(formatMetricValue(0.30000000000000004)).toBe("0.3")
	})
})

describe("expositionDocument", () => {
	it("declares a family once, before its first sample", () => {
		const document = expositionDocument([
			sample({ labels: { model: "a" } }),
			sample({ labels: { model: "b" } }),
		])

		expect(document.match(/# HELP nine_router_up/g)).toHaveLength(1)
		expect(document.match(/# TYPE nine_router_up gauge/g)).toHaveLength(1)
	})

	it("sorts label keys, so map order cannot change the bytes", () => {
		const document = expositionDocument([
			sample({ labels: { provider: "anthropic", model: "opus" } }),
		])

		expect(document).toContain('nine_router_up{model="opus",provider="anthropic"} 1')
	})

	it("emits a metric without labels with no braces", () => {
		expect(expositionDocument([sample()])).toContain("nine_router_up 1")
	})

	it("ends with a newline, or the last sample is dropped by a line reader", () => {
		expect(expositionDocument([sample()]).endsWith("\n")).toBe(true)
	})

	it("answers an empty document rather than a bare newline for no samples", () => {
		expect(expositionDocument([])).toBe("")
	})

	it("refuses a name Prometheus would reject", () => {
		// A name is written by us, so a bad one is a programming error and must not reach the
		// wire looking like a valid scrape.
		expect(() => expositionDocument([sample({ name: "9router-bad" })])).toThrow(/Invalid metric name/)
	})
})

/** A leaderboard entry as the domain builder emits it. */
const entry = (over: Record<string, unknown> = {}) => ({
	model: "claude-sonnet-4.5",
	provider: "anthropic",
	requests: 10,
	successes: 8,
	successRate: "80.0",
	promptTokens: 1000,
	completionTokens: 500,
	totalTokens: 1500,
	avgTokensPerRequest: 150,
	totalCost: 0.25,
	...over,
})

/** The forecast the projection use-case would return for a quiet install. */
const quietForecast = {
	historyDays: 0,
	observedSpend: 0,
	todaySoFar: 0,
	todayProjected: 0,
	dailyRate: 0,
	horizonDays: 30,
	projectedTotal: 0,
	budgetCap: null,
	budgetRemaining: null,
	projectedOverspend: null,
	hoursToExhaustion: null,
	exhaustedAt: null,
	confidence: "none" as const,
}

/**
 * A latency report with one provider, so the histogram half of the scrape has something to say.
 *
 * The bucket counts are cumulative, as the exposition format requires, and the last bucket is
 * `+Inf` — a histogram without it cannot be summed.
 */
const quietLatency = {
	period: "7d",
	since: null,
	truncated: false,
	rowCeiling: 20_000,
	report: {
		overall: {
			samples: 10,
			p50: 400,
			p90: 900,
			p95: 1_200,
			p99: 2_000,
			mean: 500,
			min: 100,
			max: 2_000,
			ttftSamples: 8,
			ttftP50: 200,
			ttftP95: 800,
			cachedSamples: 2,
			reliable: false,
			histogram: [],
		},
		byProvider: [
			{
				key: "anthropic",
				summary: {
					samples: 10,
					p50: 400,
					p90: 900,
					p95: 1_200,
					p99: 2_000,
					mean: 500,
					min: 100,
					max: 2_000,
					ttftSamples: 8,
					ttftP50: 200,
					ttftP95: 800,
					cachedSamples: 2,
					reliable: false,
					histogram: [
						{ le: 500, count: 6 },
						{ le: 2_000, count: 10 },
						{ le: null, count: 10 },
					],
				},
			},
		],
		byModel: [],
	},
}

function expositionWith(
	leaderboard: unknown[],
	forecast: unknown = quietForecast,
	latency: unknown = quietLatency,
) {
	const calls: Array<Record<string, unknown>> = []
	const useCase = makeMetricsExposition({
		panels: {
			leaderboard: async (period: unknown, scope: unknown) => {
				calls.push({ period, scope })
				return { period: "7d", leaderboard }
			},
		} as never,
		forecast: {
			forecast: async () => ({ period: "7d", forecast }),
		} as never,
		latency: {
			report: async (period: unknown, scope: unknown) => {
				calls.push({ latencyPeriod: period, latencyScope: scope })
				return latency
			},
		} as never,
	})
	return { useCase, calls }
}

describe("makeMetricsExposition", () => {
	it("answers with the exposition content type Prometheus negotiates on", async () => {
		const { useCase } = expositionWith([entry()])
		const scrape = await useCase.exposition("7d", { apiKeyFilter: null, allowedModels: "*" })

		expect(scrape.contentType).toBe(PROMETHEUS_CONTENT_TYPE)
		expect(scrape.period).toBe("7d")
	})

	it("derives errors from requests minus successes", async () => {
		const { useCase } = expositionWith([entry()])
		const { body } = await useCase.exposition("7d", { apiKeyFilter: null, allowedModels: "*" })

		expect(body).toContain(
			'nine_router_requests_total{model="claude-sonnet-4.5",provider="anthropic"} 10',
		)
		expect(body).toContain(
			'nine_router_request_errors_total{model="claude-sonnet-4.5",provider="anthropic"} 2',
		)
	})

	it("clamps a negative error count, which would break rate()", async () => {
		// A success recorded without its request (an import, a replayed row).
		const { useCase } = expositionWith([entry({ requests: 2, successes: 5 })])
		const { body } = await useCase.exposition("7d", { apiKeyFilter: null, allowedModels: "*" })

		expect(body).toContain("nine_router_request_errors_total")
		expect(body).not.toContain("-3")
	})

	it("splits tokens by kind, because a total cannot be attributed", async () => {
		const { useCase } = expositionWith([entry()])
		const { body } = await useCase.exposition("7d", { apiKeyFilter: null, allowedModels: "*" })

		// Keys are sorted, so `kind` leads the label set.
		expect(body).toContain(
			'nine_router_tokens_total{kind="input",model="claude-sonnet-4.5",provider="anthropic"} 1000',
		)
		expect(body).toContain(
			'nine_router_tokens_total{kind="output",model="claude-sonnet-4.5",provider="anthropic"} 500',
		)
	})

	it("labels an unrecorded provider instead of emitting an empty label", async () => {
		const { useCase } = expositionWith([entry({ provider: "" })])
		const { body } = await useCase.exposition("7d", { apiKeyFilter: null, allowedModels: "*" })

		expect(body).toContain('provider="unknown"')
	})

	it("reports the projection without inventing a budget", async () => {
		const { useCase } = expositionWith([entry()], {
			...quietForecast,
			dailyRate: 2,
			projectedTotal: 60,
		})
		const { body } = await useCase.exposition("7d", { apiKeyFilter: null, allowedModels: "*" })

		expect(body).toContain('nine_router_spend_daily_rate{confidence="none",period="7d"} 2')
		expect(body).toContain('nine_router_spend_projected{confidence="none",period="7d"} 60')
		expect(body).not.toContain("budget")
	})

	it("carries the caller's scope through to the leaderboard read", async () => {
		const { useCase, calls } = expositionWith([entry()])
		const scope = { apiKeyFilter: "key-1", allowedModels: "claude-*" }

		await useCase.exposition("30d", scope)

		expect(calls[0]).toEqual({ period: "30d", scope })
	})

	it("reads the latency window with the same period and scope as the leaderboard", async () => {
		const { useCase, calls } = expositionWith([entry()])
		const scope = { apiKeyFilter: "key-1", allowedModels: "claude-*" }

		await useCase.exposition("30d", scope)

		// One window, two reads: a scrape and the page beside it cannot disagree about "7d".
		expect(calls[1]).toEqual({ latencyPeriod: "30d", latencyScope: scope })
	})

	it("declares the latency histogram once, with an explicit +Inf bucket", async () => {
		const { useCase } = expositionWith([entry()])
		const { body } = await useCase.exposition("7d", { apiKeyFilter: null, allowedModels: "*" })

		expect(body).toContain("# TYPE nine_router_latency_ms histogram")
		expect(body.match(/# TYPE nine_router_latency_ms/g)).toHaveLength(1)
		expect(body).toContain('nine_router_latency_ms_bucket{le="+Inf",provider="anthropic"} 10')
		expect(body).toContain('nine_router_latency_ms_count{provider="anthropic"} 10')
		expect(body).toContain('nine_router_latency_p95_ms{provider="anthropic"} 1200')
		expect(body).toContain('nine_router_ttft_p95_ms{provider="anthropic"} 800')
	})

	it("prints a missing percentile as 0 rather than a value Prometheus cannot parse", async () => {
		const { useCase } = expositionWith([entry()], quietForecast, {
			...quietLatency,
			report: {
				...quietLatency.report,
				byProvider: [
					{
						key: "anthropic",
						summary: { ...quietLatency.report.byProvider[0].summary, p95: null, ttftP95: null },
					},
				],
			},
		})
		const { body } = await useCase.exposition("7d", { apiKeyFilter: null, allowedModels: "*" })

		expect(body).toContain('nine_router_latency_p95_ms{provider="anthropic"} 0')
		expect(body).not.toContain("NaN")
		expect(body).not.toContain("null")
	})
})
