/**
 * Number formatting for the usage charts.
 *
 * Three charts carried byte-identical copies of `fmtTokens`, and `fmtCost` existed in
 * four variants across the dashboard — two of them showing four decimals and two
 * showing two, so the same cost read differently on two screens. The variants are
 * kept apart here as named functions rather than collapsed, because a chart's
 * precision is a display decision, not an accident.
 *
 * This is deliberately not `formatContextWindow`: that one rounds millions to whole
 * numbers and prints a lower-case `k`, which is right for a model's window and wrong
 * for an axis label.
 */

/**
 * A compact token count for an axis or legend: `1.2M`, `850.0K`, `42`.
 *
 * One decimal at both scales, so the labels stay visually aligned.
 */
export function formatTokenCount(n: number | null | undefined): string {
	const value = Number(n) || 0
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
	if (value >= 1000) return `${(value / 1000).toFixed(1)}K`
	return String(value)
}

/**
 * The same, with two decimals on millions. Used where the extra digit carries
 * information; kept separate so unifying it later is a deliberate change.
 */
export function formatTokenCountPrecise(n: number | null | undefined): string {
	const value = Number(n) || 0
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
	if (value >= 1000) return `${(value / 1000).toFixed(1)}K`
	return String(value)
}

/**
 * A cost with precision proportional to its size: whole dollars over $100, cents
 * over $1, and four decimals below that so a fraction of a cent is not shown as $0.00.
 * A model with no price contributes 0 and reads `$0`.
 */
export function formatCostScaled(n: number | null | undefined): string {
	const value = Number(n) || 0
	if (!value) return "$0"
	if (value >= 100) return `$${value.toFixed(0)}`
	if (value >= 1) return `$${value.toFixed(2)}`
	return `$${value.toFixed(4)}`
}

/** A cost to the cent, for totals where sub-cent noise is not wanted. */
export function formatCostCents(n: number | null | undefined): string {
	return `$${(Number(n) || 0).toFixed(2)}`
}

/** A cost to four decimals, for per-request rows where cents would read as $0.00. */
export function formatCostPrecise(n: number | null | undefined): string {
	return `$${(Number(n) || 0).toFixed(4)}`
}

/** A plain grouped count. */
export function formatCount(n: number | null | undefined): string {
	return new Intl.NumberFormat().format(Number(n) || 0)
}

/** An ungrouped count, for a bar chart's raw axis values. */
export function formatRawCount(n: number | null | undefined): string {
	return String(Number(n) || 0)
}

/**
 * Bytes at one decimal, capped at MB: `1.0 KB`, `1.5 MB`, `512 B`.
 *
 * Capped deliberately. Callers showing a request body never exceed a few MB, and a
 * cap keeps the column width predictable; `formatByteSize` is the unbounded variant.
 */
export function formatBytes(n: number | null | undefined): string {
	const value = Number(n) || 0
	if (value < 1024) return `${value} B`
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
	return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Bytes scaled to B/KB/MB/GB, with trailing zeros dropped: `1 KB`, `5 GB`, `1.5 MB`.
 *
 * Used for backup sizes, where a multi-gigabyte database must not read as
 * `5120.0 MB`.
 */
export function formatByteSize(bytes: number | null | undefined): string {
	const value = Number(bytes) || 0
	if (!value) return "0 B"
	const k = 1024
	const sizes = ["B", "KB", "MB", "GB"]
	const i = Math.min(Math.floor(Math.log(value) / Math.log(k)), sizes.length - 1)
	return `${parseFloat((value / k ** i).toFixed(1))} ${sizes[i]}`
}
