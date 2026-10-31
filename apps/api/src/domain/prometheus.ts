/**
 * Prometheus text exposition (format 0.0.4), built from our own samples.
 *
 * A metrics endpoint is only useful if a scrape is *comparable* to the last one, so this
 * module is written around three properties a hand-rolled formatter gets wrong:
 *
 * 1. **Byte-stable output.** Label keys are sorted and families appear in first-seen order.
 *    Without the sort, two scrapes of identical data produce different bytes, every dashboard
 *    diff looks like a change, and `promtool` cannot tell a real regression from map ordering.
 *
 * 2. **Escaping, once.** A label value is free text — a model name can carry a quote, a
 *    provider an apostrophe. Prometheus wants `\\`, `\"` and `\n` escaped inside the quotes;
 *    an unescaped quote ends the label early and the whole scrape is rejected, which in
 *    Grafana looks like "9router is down".
 *
 * 3. **Numbers Prometheus can parse.** `Infinity` and `NaN` are not in the text format — the
 *    spec spells them `+Inf`, `-Inf`, `NaN`. `String(Infinity)` produces the first and the
 *    scrape dies on a value that a zero-rate average produces routinely.
 *
 * Sums of money also arrive with float noise (`0.30000000000000004`). Values are rounded to
 * six decimals before printing: a scrape does not need more precision than the currency it
 * reports, and the noise makes every comparison a diff.
 */
import { AppError } from "./errors.ts"

export type MetricType = "counter" | "gauge" | "histogram"

/** One line of the exposition: a metric family member. */
export interface MetricSample {
	/** `[a-zA-Z_:][a-zA-Z0-9_:]*` — the exposition format's name rule. */
	readonly name: string
	readonly type: MetricType
	/** Printed once per family, in `# HELP`. */
	readonly help: string
	readonly labels?: Readonly<Record<string, string | number>>
	readonly value: number
	/**
	 * The family this sample belongs to, when it is not its own name.
	 *
	 * A histogram is one family whose samples carry suffixes — `_bucket`, `_sum`, `_count` — and
	 * `# TYPE` names the family, not the sample. Without this field the document would declare
	 * three separate families and Prometheus would reject the scrape: a `_bucket` series with no
	 * declared histogram is not something `histogram_quantile()` can read.
	 */
	readonly family?: string
}

/** Decimal places kept before printing, so float noise cannot create a diff. */
const VALUE_DECIMALS = 6

const NAME_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/

/** A label value with the three characters the format reserves escaped. */
export function escapeLabelValue(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")
}

/** `# HELP` text: the format escapes backslashes and newlines, and nothing else. */
function escapeHelp(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n")
}

/**
 * A value the exposition format can parse.
 *
 * The non-finite spellings are the point: `String(Infinity)` is `"Infinity"`, which the
 * format does not define, so a single zero-rate average would fail an entire scrape.
 */
export function formatMetricValue(value: number): string {
	if (Number.isNaN(value)) return "NaN"
	if (value === Number.POSITIVE_INFINITY) return "+Inf"
	if (value === Number.NEGATIVE_INFINITY) return "-Inf"
	if (Number.isInteger(value)) return String(value)
	const rounded = Number(value.toFixed(VALUE_DECIMALS))
	return String(rounded)
}

/** `{a="1",b="2"}` with keys sorted, or an empty string when there are no labels. */
export function formatLabels(labels: MetricSample["labels"]): string {
	if (!labels) return ""
	const keys = Object.keys(labels).sort()
	if (keys.length === 0) return ""
	const rendered = keys.map((key) => `${key}="${escapeLabelValue(String(labels[key]))}"`)
	return `{${rendered.join(",")}}`
}

/**
 * The whole document.
 *
 * A family's `# HELP` and `# TYPE` are emitted once, at the first sample that mentions it:
 * repeating them is invalid, and omitting them makes the metric untyped in Prometheus, which
 * turns a counter into something `rate()` refuses.
 */
export function expositionDocument(samples: readonly MetricSample[]): string {
	const lines: string[] = []
	const declared = new Set<string>()

	for (const sample of samples) {
		const family = sample.family ?? sample.name
		if (!NAME_PATTERN.test(family) || !NAME_PATTERN.test(sample.name)) {
			// A programming error, not caller input: a metric name is written by us, and a bad
			// one silently produces a family Prometheus rejects.
			throw new AppError("INTERNAL", `Invalid metric name: ${sample.name}`)
		}
		if (!declared.has(family)) {
			declared.add(family)
			lines.push(`# HELP ${family} ${escapeHelp(sample.help)}`)
			lines.push(`# TYPE ${family} ${sample.type}`)
		}
		lines.push(`${sample.name}${formatLabels(sample.labels)} ${formatMetricValue(sample.value)}`)
	}

	// The format wants a trailing newline; a scraper that reads line-by-line otherwise drops
	// the last sample.
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`
}
