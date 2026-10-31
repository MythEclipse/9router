"use client"

import { useEffect, useState } from "react"
import EmptyWithAction from "./EmptyWithAction.tsx"

/** A duration in milliseconds, as an operator reads it. */
function ms(value) {
	if (value === null || value === undefined) return "—"
	if (value < 1000) return `${Math.round(value)} ms`
	return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`
}

/** A share, as a percentage with no false precision. */
function pct(value) {
	if (value === null || value === undefined) return "—"
	return `${Math.round(value * 100)}%`
}

function SummaryCard({ label, value, hint, tone = "text-text-main" }) {
	return (
		<div className="rounded-xl border border-border bg-surface-2 p-4">
			<div className="text-xs font-medium text-text-muted">{label}</div>
			<div className={`mt-1 text-2xl font-semibold tabular-nums ${tone}`}>{value}</div>
			{hint && <div className="mt-1 text-xs text-text-muted">{hint}</div>}
		</div>
	)
}

/**
 * Where the requests actually spend their time.
 *
 * Three things this panel exists to answer, none of which the dashboard could answer before:
 * which provider is slow *this week* (a percentile over the window, not a single sample), how
 * much of the wait is before the first token (TTFT) rather than in the stream, and whether the
 * gateway itself is saturated right now (the admission gate's counters).
 *
 * The numbers come from the same rows the usage totals are built from, so a request counted on
 * the Overview tab is also counted here.
 */
export default function HealthTab({ period }) {
	const [latency, setLatency] = useState(null)
	const [queue, setQueue] = useState(null)
	const [anomalies, setAnomalies] = useState(null)
	const [loading, setLoading] = useState(true)

	useEffect(() => {
		let alive = true
		setLoading(true)
		Promise.all([
			fetch(`/api/usage/latency?period=${period}`).then((r) => (r.ok ? r.json() : null)),
			fetch("/api/queue").then((r) => (r.ok ? r.json() : null)),
			fetch(`/api/usage/anomalies?period=${period}`).then((r) => (r.ok ? r.json() : null)),
		])
			.then(([latencyData, queueData, anomalyData]) => {
				if (!alive) return
				setLatency(latencyData)
				setQueue(queueData)
				setAnomalies(anomalyData)
			})
			.catch(() => {
				if (alive) setLatency(null)
			})
			.finally(() => {
				if (alive) setLoading(false)
			})
		return () => {
			alive = false
		}
	}, [period])

	if (loading) return <div className="text-sm text-text-muted">Loading latency…</div>

	const overall = latency?.report?.overall
	if (!overall || overall.samples === 0) {
		return (
			<EmptyWithAction
				icon="timer"
				title="No timed requests in this window"
				hint="Latency is measured on every request the gateway completes. Send one and this panel fills in."
				actionHref="/dashboard/endpoint"
				actionLabel="Get an API key"
			/>
		)
	}

	const providers = latency.report.byProvider || []
	const models = latency.report.byModel || []
	const found = anomalies?.anomalies || []
	const histogram = overall.histogram || []
	const largestBucket = Math.max(1, ...histogram.map((bucket) => bucket.count))

	return (
		<div className="flex flex-col gap-4">
			<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
				<SummaryCard label="p50" value={ms(overall.p50)} hint={`${overall.samples} timed requests`} />
				<SummaryCard
					label="p95"
					value={ms(overall.p95)}
					hint={overall.reliable ? "Tail latency" : "Provisional: under 20 samples"}
					tone={overall.reliable ? "text-text-main" : "text-text-muted"}
				/>
				<SummaryCard label="p99" value={ms(overall.p99)} hint="Worst 1% of requests" />
				<SummaryCard
					label="TTFT p95"
					value={ms(overall.ttftP95)}
					hint={overall.ttftSamples > 0 ? `${overall.ttftSamples} streamed` : "No streamed requests"}
				/>
			</div>

			{/* The gate's own counters. `inFlight` used to read 0 forever because the queue
			    endpoint held a second, never-entered gate. */}
			<div className="rounded-xl border border-border bg-surface-2 p-4">
				<div className="mb-2 text-sm font-medium text-text-main">Admission gate</div>
				<div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
					<div>
						<div className="text-xs text-text-muted">In flight</div>
						<div className="tabular-nums text-text-main">{queue?.inFlight ?? "—"}</div>
					</div>
					<div>
						<div className="text-xs text-text-muted">Waiting</div>
						<div className="tabular-nums text-text-main">{queue?.waiting ?? "—"}</div>
					</div>
					<div>
						<div className="text-xs text-text-muted">Concurrency</div>
						<div className="tabular-nums text-text-main">{queue?.concurrency ?? "—"}</div>
					</div>
					<div>
						<div className="text-xs text-text-muted">Mean service</div>
						<div className="tabular-nums text-text-main">{ms(queue?.meanServiceMs)}</div>
					</div>
				</div>
			</div>

			<div className="rounded-xl border border-border bg-surface-2 p-4">
				<div className="mb-3 text-sm font-medium text-text-main">Duration distribution</div>
				<div className="flex flex-col gap-1.5">
					{histogram.map((bucket) => {
						const label = bucket.le === null ? "∞" : ms(bucket.le)
						return (
							<div key={label} className="flex items-center gap-2 text-xs">
								<span className="w-16 shrink-0 text-right text-text-muted tabular-nums">≤ {label}</span>
								<div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-3">
									<div
										className="h-full rounded-full bg-accent"
										style={{ width: `${(bucket.count / largestBucket) * 100}%` }}
									/>
								</div>
								<span className="w-12 shrink-0 text-text-muted tabular-nums">{bucket.count}</span>
							</div>
						)
					})}
				</div>
				<div className="mt-2 text-xs text-text-muted">
					Cumulative: each row counts the requests at or below that duration.
				</div>
			</div>

			<div className="rounded-xl border border-border bg-surface-2 p-4">
				<div className="mb-2 text-sm font-medium text-text-main">Slowest providers</div>
				<div className="overflow-x-auto">
					<table className="w-full text-sm">
						<thead>
							<tr className="border-b border-border">
								<th className="px-3 py-2 text-left font-medium text-text-muted">Provider</th>
								<th className="px-3 py-2 text-right font-medium text-text-muted">Requests</th>
								<th className="px-3 py-2 text-right font-medium text-text-muted">p50</th>
								<th className="px-3 py-2 text-right font-medium text-text-muted">p95</th>
								<th className="px-3 py-2 text-right font-medium text-text-muted">TTFT p95</th>
								<th className="px-3 py-2 text-right font-medium text-text-muted">Cached</th>
							</tr>
						</thead>
						<tbody>
							{providers.map((group) => (
								<tr key={group.key} className="border-b border-border/50 hover:bg-state-hover">
									<td className="px-3 py-2 text-text-main">{group.key}</td>
									<td className="px-3 py-2 text-right tabular-nums text-text-muted">
										{group.summary.samples}
									</td>
									<td className="px-3 py-2 text-right tabular-nums text-text-main">
										{ms(group.summary.p50)}
									</td>
									<td className="px-3 py-2 text-right tabular-nums text-text-main">
										{ms(group.summary.p95)}
									</td>
									<td className="px-3 py-2 text-right tabular-nums text-text-muted">
										{ms(group.summary.ttftP95)}
									</td>
									<td className="px-3 py-2 text-right tabular-nums text-text-muted">
										{group.summary.cachedSamples}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
				{providers.length === 0 && (
					<div className="text-xs text-text-muted">No provider was recorded in this window.</div>
				)}
			</div>

			<div className="rounded-xl border border-border bg-surface-2 p-4">
				<div className="mb-2 text-sm font-medium text-text-main">Slowest models</div>
				<div className="overflow-x-auto">
					<table className="w-full text-sm">
						<thead>
							<tr className="border-b border-border">
								<th className="px-3 py-2 text-left font-medium text-text-muted">Model</th>
								<th className="px-3 py-2 text-right font-medium text-text-muted">Requests</th>
								<th className="px-3 py-2 text-right font-medium text-text-muted">p50</th>
								<th className="px-3 py-2 text-right font-medium text-text-muted">p95</th>
							</tr>
						</thead>
						<tbody>
							{models.slice(0, 15).map((group) => (
								<tr key={group.key} className="border-b border-border/50 hover:bg-state-hover">
									<td className="max-w-[280px] truncate px-3 py-2 text-text-main" title={group.key}>
										{group.key}
									</td>
									<td className="px-3 py-2 text-right tabular-nums text-text-muted">
										{group.summary.samples}
									</td>
									<td className="px-3 py-2 text-right tabular-nums text-text-main">
										{ms(group.summary.p50)}
									</td>
									<td className="px-3 py-2 text-right tabular-nums text-text-main">
										{ms(group.summary.p95)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</div>

			<div className="rounded-xl border border-border bg-surface-2 p-4">
				<div className="mb-2 text-sm font-medium text-text-main">Spend anomalies</div>
				{found.length === 0 ? (
					<div className="text-xs text-text-muted">
						No hour spent far above its own trailing baseline in this window.
					</div>
				) : (
					<ul className="flex flex-col gap-2 text-sm">
						{found.slice(0, 10).map((anomaly) => (
							<li
								key={`${anomaly.key}-${anomaly.hour}`}
								className="flex flex-wrap items-baseline gap-2 border-b border-border/50 pb-2"
							>
								<span
									className={
										anomaly.severity === "critical" ? "font-medium text-danger" : "font-medium text-warning"
									}
								>
									${anomaly.cost.toFixed(2)}
								</span>
								<span className="text-text-muted">
									at {anomaly.hour} · usual ${anomaly.baseline.toFixed(2)} · {anomaly.multiple}x · z{" "}
									{anomaly.zScore}
								</span>
								<span className="text-text-muted">
									({anomaly.key === "*" ? "whole install" : anomaly.key.slice(0, 8)})
								</span>
							</li>
						))}
					</ul>
				)}
				<div className="mt-2 text-xs text-text-muted">
					{anomalies
						? `${anomalies.keysScanned} key${anomalies.keysScanned === 1 ? "" : "s"} scanned, ${pct(
								overall.cachedSamples / Math.max(1, overall.samples),
							)} of requests answered from cache.`
						: ""}
				</div>
			</div>
		</div>
	)
}
