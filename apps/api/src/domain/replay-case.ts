/**
 * Turn a captured request into a translator regression case.
 *
 * The observability log already stores, for every request, what the client sent and what the
 * provider was handed. That pair *is* a translator test — the only missing step is writing it
 * down. This module does that, and refuses the three ways the resulting fixture would be
 * worthless:
 *
 * 1. **A case with nothing to compare.** A detail without `providerRequest` proves nothing
 *    about translation; including it produces a test that passes because it asserts `undefined`.
 * 2. **A fixture that changes every run.** Timestamps, request ids and UUIDs are replaced with
 *    stable placeholders, so regenerating the file yields an empty diff instead of noise.
 * 3. **A fixture that leaks a credential.** The same rule as the config export: any field
 *    named like a secret is replaced, because these files get committed.
 */

/** One captured request, as the observability log stores it. */
export interface CapturedDetail {
	readonly id?: string | null
	readonly timestamp?: string | number | null
	readonly provider?: string | null
	readonly model?: string | null
	readonly resolvedModel?: string | null
	readonly status?: string | null
	readonly request?: unknown
	readonly providerRequest?: unknown
	readonly providerResponse?: unknown
	readonly response?: unknown
}

/** A translator case: what went in, what the provider got, what came back. */
export interface ReplayCase {
	readonly name: string
	readonly provider: string
	readonly model: string
	readonly request: unknown
	readonly providerRequest: unknown
	readonly response: unknown
	readonly providerResponse: unknown
}

const SECRET_FIELD =
	/^(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|cookie|x-api-key)$/i
const VOLATILE_FIELD =
	/^(id|request[-_]?id|response[-_]?id|created|created[-_]?at|timestamp|system[-_]?fingerprint|session[-_]?id)$/i

/** Deep-copy a value with secrets redacted and volatile fields replaced. */
export function stableValue(value: unknown, key = ""): unknown {
	if (Array.isArray(value)) return value.map((entry) => stableValue(entry))
	if (value === null || typeof value !== "object") return value

	const out: Record<string, unknown> = {}
	for (const [field, entry] of Object.entries(value as Record<string, unknown>)) {
		if (SECRET_FIELD.test(field)) {
			out[field] = "[REDACTED]"
		} else if (VOLATILE_FIELD.test(field) && typeof entry !== "object") {
			out[field] = placeholderFor(field, entry)
		} else {
			out[field] = stableValue(entry, field)
		}
	}
	return out
}

/** A stable stand-in that still shows the field's shape. */
function placeholderFor(field: string, entry: unknown): unknown {
	if (typeof entry === "number") return 0
	if (typeof entry === "boolean") return entry
	return `<${field}>`
}

/** A readable, unique name for the generated test. */
export function caseName(detail: CapturedDetail, index = 0): string {
	const provider = detail.provider ?? "unknown"
	const model = (detail.model ?? "model").replace(/[^a-zA-Z0-9._-]+/g, "-")
	return `${provider} ${model} #${index + 1}`
}

/**
 * The case a captured request yields, or `null` when it cannot prove anything.
 *
 * `providerRequest` is the whole point: without it there is no expected translation, so the
 * capture is a usage row, not a translator case.
 */
export function replayCaseOf(detail: CapturedDetail, index = 0): ReplayCase | null {
	if (detail.providerRequest === null || detail.providerRequest === undefined) return null
	if (detail.request === null || detail.request === undefined) return null

	return {
		name: caseName(detail, index),
		provider: detail.provider ?? "unknown",
		model: detail.resolvedModel ?? detail.model ?? "unknown",
		request: stableValue(detail.request),
		providerRequest: stableValue(detail.providerRequest),
		response: stableValue(detail.response ?? null),
		providerResponse: stableValue(detail.providerResponse ?? null),
	}
}

/** The cases a batch of captures yields, in capture order, skipping the unusable ones. */
export function replayCasesOf(details: readonly CapturedDetail[]): ReplayCase[] {
	return details
		.map((detail, index) => replayCaseOf(detail, index))
		.filter((entry): entry is ReplayCase => entry !== null)
}

const literal = (value: unknown): string => JSON.stringify(value, null, 2)

/**
 * A vitest file asserting each case's translation.
 *
 * Written as a golden comparison rather than a live call: the point of a replay suite is to
 * catch a translator change, and that only needs the recorded pair, not a provider.
 */
export function vitestSource(
	cases: readonly ReplayCase[],
	title = "replayed translations",
): string {
	if (cases.length === 0) {
		throw new Error("no replayable cases: every capture lacked a provider request")
	}

	const blocks = cases
		.map(
			(entry) => `	it(${JSON.stringify(entry.name)}, () => {
		const captured = ${literal(entry.request)}
		const expected = ${literal(entry.providerRequest)}
		expect(translate(captured, ${JSON.stringify(entry.provider)})).toEqual(expected)
	})`,
		)
		.join("\n\n")

	return `// Generated by POST /api/requests/replay. Recorded pairs, not live calls.
import { describe, expect, it } from "vitest"
import { translate } from "9router-open-sse/translator/index.ts"

describe(${JSON.stringify(title)}, () => {
${blocks}
})
`
}
