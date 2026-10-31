"use client"

import { useEffect, useState } from "react"

/** One row of the trail, grouped so a reader can scan verbs of the same resource together. */
function Entry({ entry }) {
	const [open, setOpen] = useState(false)
	const fields = Object.entries(entry.detail || {})
	const changed = fields.filter(([key]) => key.startsWith("changed:"))
	const scalars = fields.filter(([key]) => !key.startsWith("changed:"))

	return (
		<li className="border-b border-border/50 py-2.5">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				className="flex w-full flex-wrap items-baseline gap-2 text-left text-sm hover:text-text-main"
			>
				<span className="font-mono text-xs text-accent">{entry.action}</span>
				<span className="text-text-main">{entry.subject}</span>
				<span className="text-text-muted">{new Date(entry.at).toLocaleString()}</span>
			</button>
			{open && (
				<div className="mt-2 flex flex-col gap-1 text-xs text-text-muted">
					{scalars.map(([key, value]) => (
						<div key={key}>
							<span className="text-text-main">{key}</span>: {String(value)}
						</div>
					))}
					{changed.length > 0 && (
						<div>
							<span className="text-text-main">fields touched</span>:{" "}
							{changed.map(([key]) => key.replace("changed:", "")).join(", ")}
						</div>
					)}
					{fields.length === 0 && <div>No detail was recorded for this change.</div>}
				</div>
			)}
		</li>
	)
}

/**
 * The audit trail.
 *
 * The install recorded two kinds of change before this page existed (creating an API key and
 * editing one); every other admin mutation — a deleted connection, a rewritten budget, a swapped
 * pricing table — left nothing behind but the row it altered. The question "who removed this"
 * had no answer, and the answer is not in the diff because the diff is gone.
 *
 * Values are deliberately not shown for most fields: the writer keeps identifiers and the names
 * of the fields that moved, not their contents. A log that copies the record is a second copy of
 * the database, including the credentials that were the point of the change.
 */
export default function AuditLogPage() {
	const [data, setData] = useState(null)
	const [error, setError] = useState(null)
	const [loading, setLoading] = useState(true)
	const [limit, setLimit] = useState("100")

	useEffect(() => {
		let alive = true
		setLoading(true)
		setError(null)
		fetch(`/api/audit-log?limit=${limit}`)
			.then(async (response) => {
				const body = await response.json()
				if (!response.ok) throw new Error(body?.error?.message || "Request failed")
				return body
			})
			.then((body) => {
				if (alive) setData(body)
			})
			.catch((cause) => {
				if (alive) setError(cause.message)
			})
			.finally(() => {
				if (alive) setLoading(false)
			})
		return () => {
			alive = false
		}
	}, [limit])

	const entries = data?.entries || []

	return (
		<div className="flex min-w-0 flex-col gap-4 px-1 sm:px-0">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div>
					<h1 className="text-lg font-semibold text-text-main">Audit log</h1>
					<p className="text-xs text-text-muted">
						Every dashboard mutation that landed, newest first. Reads are not recorded.
					</p>
				</div>
				<label className="flex items-center gap-2 text-xs text-text-muted">
					Show
					<select
						value={limit}
						onChange={(event) => setLimit(event.target.value)}
						className="rounded-md border border-border bg-surface-2 px-2 py-1 text-text-main"
					>
						{[50, 100, 250, 500].map((value) => (
							<option key={value} value={String(value)}>
								{value}
							</option>
						))}
					</select>
				</label>
			</div>

			<div className="rounded-xl border border-border bg-surface-2 p-4">
				{loading && <div className="text-sm text-text-muted">Loading the trail…</div>}
				{!loading && error && <div className="text-sm text-danger">{error}</div>}
				{!loading && !error && entries.length === 0 && (
					<div className="text-sm text-text-muted">
						Nothing has been changed yet. Creating a connection, editing a budget or swapping a pricing
						table appears here.
					</div>
				)}
				{!loading && !error && entries.length > 0 && (
					<ul className="flex flex-col">
						{entries.map((entry) => (
							<Entry key={entry.id} entry={entry} />
						))}
					</ul>
				)}
			</div>
		</div>
	)
}
