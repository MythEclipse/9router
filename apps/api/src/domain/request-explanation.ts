/**
 * Explain one captured request: what it asked for, what the translator changed, and what it cost.
 *
 * "Why did this request go there, and why did it look like that when it arrived?" is the
 * question the log already holds the answer to — but as two opaque JSON blobs. This turns them
 * into a diff and a list of steps, and refuses to invent the parts it does not know:
 *
 * 1. **No cause it cannot see.** The stored row does not record which router branch fired or
 *    which alternative connections were skipped, so the explanation never claims one. It
 *    reports the decision that is visible (provider, connection, resolved model) and stops.
 * 2. **A diff, not a guess.** What the translator changed is computed by comparing the client
 *    body with the provider body — field by field — rather than described in prose that could
 *    drift from the code.
 * 3. **Cost from rates, not from memory.** The estimate uses the recorded token counts and the
 *    pricing table; when either is missing the answer is `null`, never `0`.
 */

/** One captured request, as the log stores it. */
export interface ExplainedDetail {
	readonly id?: string | null
	readonly timestamp?: string | number | null
	readonly provider?: string | null
	readonly model?: string | null
	readonly resolvedModel?: string | null
	readonly connectionId?: string | null
	readonly status?: string | number | null
	readonly latency?: Record<string, unknown> | null
	readonly tokens?: Record<string, unknown> | null
	readonly request?: unknown
	readonly providerRequest?: unknown
	readonly response?: unknown
	readonly providerResponse?: unknown
}

/** What changed between two JSON bodies, at the top level. */
export interface FieldChange {
	readonly field: string
	readonly change: "added" | "removed" | "changed"
	readonly from?: string
	readonly to?: string
}

/** One step of the pipeline, in the order it happened. */
export interface PipelineStep {
	readonly step: "received" | "translated" | "routed" | "answered"
	readonly detail: string
}

export interface RequestExplanation {
	readonly id: string | null
	readonly steps: readonly PipelineStep[]
	readonly changes: readonly FieldChange[]
	readonly tokens: Readonly<Record<string, number>>
	readonly costUsd: number | null
	readonly latencyMs: number | null
	/** What the log cannot answer about this request, stated rather than omitted. */
	readonly unknown: readonly string[]
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

/** A short, stable rendering of a value for the diff. */
function render(value: unknown): string {
	if (value === undefined) return "undefined"
	if (typeof value === "string") return value.length > 80 ? `${value.slice(0, 77)}…` : value
	if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value)
	if (Array.isArray(value)) return `[${value.length} item${value.length === 1 ? "" : "s"}]`
	if (isObject(value))
		return `{${Object.keys(value).length} key${Object.keys(value).length === 1 ? "" : "s"}}`
	return typeof value
}

/**
 * The top-level fields that differ between the client body and the provider body.
 *
 * Top level only: a nested diff is a different report, and pretending one level covers the other
 * would hide the case where `messages` was rewritten wholesale — which the `changed` row states.
 */
export function fieldChanges(client: unknown, provider: unknown): FieldChange[] {
	if (!isObject(client) || !isObject(provider)) return []

	const changes: FieldChange[] = []
	const fields = new Set([...Object.keys(client), ...Object.keys(provider)])

	for (const field of [...fields].sort()) {
		const before = client[field]
		const after = provider[field]
		if (JSON.stringify(before) === JSON.stringify(after)) continue

		if (before === undefined) {
			changes.push({ field, change: "added", to: render(after) })
		} else if (after === undefined) {
			changes.push({ field, change: "removed", from: render(before) })
		} else {
			changes.push({ field, change: "changed", from: render(before), to: render(after) })
		}
	}

	return changes
}

/** Token counts the log recorded, ignoring anything that is not a number. */
export function tokensOf(detail: ExplainedDetail): Record<string, number> {
	const tokens: Record<string, number> = {}
	for (const [name, value] of Object.entries(detail.tokens ?? {})) {
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) tokens[name] = value
	}
	return tokens
}

/** The latency the log recorded, from whichever field it used. */
export function latencyOf(detail: ExplainedDetail): number | null {
	const latency = detail.latency ?? {}
	for (const field of ["total", "totalMs", "duration", "durationMs", "ms"]) {
		const value = latency[field]
		if (typeof value === "number" && Number.isFinite(value)) return value
	}
	return null
}

/**
 * The explanation of one request.
 *
 * `costUsd` is passed in rather than computed here: pricing is a table, and a domain rule that
 * imported it would be reading configuration.
 */
export function explainRequest(
	detail: ExplainedDetail,
	costUsd: number | null = null,
): RequestExplanation {
	const steps: PipelineStep[] = []
	const unknown: string[] = []

	const requested = isObject(detail.request) ? detail.request : null
	const received = requested?.model ?? detail.model ?? "unknown model"
	steps.push({
		step: "received",
		detail: `client asked for ${String(received)}${requested?.stream === true ? " (streamed)" : ""}`,
	})

	const changes = fieldChanges(detail.request, detail.providerRequest)
	if (detail.providerRequest === undefined || detail.providerRequest === null) {
		unknown.push("no provider request was captured, so the translation cannot be shown")
	} else {
		steps.push({
			step: "translated",
			detail:
				changes.length === 0
					? "the body was forwarded unchanged"
					: `${changes.length} top-level field${changes.length === 1 ? "" : "s"} rewritten`,
		})
	}

	const target = detail.resolvedModel ?? detail.model ?? "unknown"
	steps.push({
		step: "routed",
		detail: `sent to ${detail.provider ?? "an unrecorded provider"}${detail.connectionId ? ` via connection ${detail.connectionId}` : ""} as ${String(target)}`,
	})

	steps.push({
		step: "answered",
		detail: `status ${String(detail.status ?? "unrecorded")}${
			latencyOf(detail) === null ? "" : ` in ${latencyOf(detail)} ms`
		}`,
	})

	// The router's alternatives are not in the row; saying so is more useful than silence.
	unknown.push("which other connections were considered, and why they were skipped, is not recorded")
	if (detail.resolvedModel && detail.model && detail.resolvedModel !== detail.model) {
		unknown.push(
			`why ${String(detail.model)} resolved to ${String(detail.resolvedModel)} is not recorded`,
		)
	}

	return {
		id: detail.id ? String(detail.id) : null,
		steps,
		changes,
		tokens: tokensOf(detail),
		costUsd,
		latencyMs: latencyOf(detail),
		unknown,
	}
}
