/**
 * The `/v1/batches` shape: a JSONL job file, its lifecycle, and the output file it produces.
 *
 * A batch is the one API where "accepted" and "done" are far apart, so the lifecycle is the
 * feature. Three things this refuses to get wrong:
 *
 * 1. **A status that moves backwards.** `completed` is terminal; a late worker tick that flips it
 *    back to `in_progress` makes a finished job look busy forever. Transitions are checked.
 * 2. **A line without a `custom_id`.** The output file is keyed by it; a line missing one cannot
 *    be matched to its result, so the whole file is refused rather than half-processed.
 * 3. **An endpoint the gateway does not batch.** `/v1/chat/completions` and `/v1/responses` are
 *    the two that answer one body per line; accepting anything else produces a job that fails
 *    every request identically.
 */

export const BATCH_STATES = [
	"validating",
	"failed",
	"in_progress",
	"finalizing",
	"completed",
	"expired",
	"cancelling",
	"cancelled",
] as const

export type BatchState = (typeof BATCH_STATES)[number]

/** The endpoints a batch may target. */
export const BATCH_ENDPOINTS = ["/v1/chat/completions", "/v1/responses"] as const

/** How many request lines one batch may hold. */
export const MAX_BATCH_LINES = 500

/** One line of the input file. */
export interface BatchRequestLine {
	readonly custom_id: string
	readonly method?: string
	readonly url?: string
	readonly body: unknown
}

/** The batch object as the OpenAI API reports it. */
export interface BatchMeta {
	readonly id: string
	readonly object: "batch"
	readonly endpoint: string
	readonly input_file_id: string
	readonly completion_window: string
	readonly status: BatchState
	readonly created_at: number
	readonly in_progress_at?: number
	readonly completed_at?: number
	readonly failed_at?: number
	readonly cancelled_at?: number
	readonly output_file_id?: string
	readonly error_file_id?: string
	readonly request_counts: {
		readonly total: number
		readonly completed: number
		readonly failed: number
	}
	readonly errors?: { readonly message: string } | null
}

/** Transitions a batch may make. Anything else is a bug in the runner, not a state. */
const TRANSITIONS: Record<BatchState, readonly BatchState[]> = {
	validating: ["in_progress", "cancelling", "failed"],
	in_progress: ["finalizing", "cancelling", "failed"],
	finalizing: ["completed", "failed"],
	cancelling: ["cancelled"],
	completed: [],
	failed: [],
	expired: [],
	cancelled: [],
}

/** Whether a batch may move from `from` to `to`. */
export function mayTransition(from: BatchState, to: BatchState): boolean {
	return TRANSITIONS[from]?.includes(to) ?? false
}

/** The endpoint, or `null` when the gateway cannot batch it. */
export function endpointOf(value: unknown): string | null {
	if (typeof value !== "string") return null
	const trimmed = value.trim()
	return (BATCH_ENDPOINTS as readonly string[]).includes(trimmed) ? trimmed : null
}

/** A batch id, in the shape clients parse. */
export function batchIdOf(random: () => Uint8Array): string {
	const bytes = random()
	const hex = Array.from(bytes.slice(0, 12), (byte) => byte.toString(16).padStart(2, "0")).join("")
	return `batch_${hex}`
}

/**
 * The request lines a JSONL payload holds, or a reason it is unusable.
 *
 * A blank line is skipped (trailing newlines are normal), but a line without a `custom_id` or
 * without a parseable body refuses the whole file: half a batch is worse than a clear error,
 * because the caller cannot tell which half.
 */
export function parseBatchLines(text: string): { lines: BatchRequestLine[] } | { error: string } {
	const lines: BatchRequestLine[] = []

	for (const [index, raw] of text.split("\n").entries()) {
		if (raw.trim() === "") continue

		let parsed: unknown
		try {
			parsed = JSON.parse(raw)
		} catch {
			return { error: `line ${index + 1} is not valid JSON` }
		}

		if (typeof parsed !== "object" || parsed === null) {
			return { error: `line ${index + 1} is not an object` }
		}

		const entry = parsed as Record<string, unknown>
		const customId = entry.custom_id
		if (typeof customId !== "string" || customId.trim() === "") {
			return { error: `line ${index + 1} has no custom_id` }
		}
		if (!("body" in entry)) {
			return { error: `line ${index + 1} has no body` }
		}

		lines.push({
			custom_id: customId,
			method: typeof entry.method === "string" ? entry.method : undefined,
			url: typeof entry.url === "string" ? entry.url : undefined,
			body: entry.body,
		})
	}

	if (lines.length === 0) return { error: "the input file holds no request lines" }
	if (lines.length > MAX_BATCH_LINES) {
		return { error: `a batch may hold at most ${MAX_BATCH_LINES} request lines` }
	}

	const seen = new Set<string>()
	for (const line of lines) {
		if (seen.has(line.custom_id)) return { error: `duplicate custom_id "${line.custom_id}"` }
		seen.add(line.custom_id)
	}

	return { lines }
}

/** One line of the output file. */
export function outputLineOf(customId: string, status: number, body: unknown): string {
	return JSON.stringify({
		id: `batch_req_${customId}`,
		custom_id: customId,
		response: { status_code: status, request_id: customId, body },
		error: null,
	})
}

/** One line of the error file, for a request the gateway could not complete. */
export function errorLineOf(customId: string, message: string): string {
	return JSON.stringify({
		id: `batch_req_${customId}`,
		custom_id: customId,
		response: { status_code: 500, request_id: customId, body: null },
		error: { code: "request_failed", message },
	})
}

/** The initial batch object. */
export function batchMetaOf(input: {
	readonly id: string
	readonly endpoint: string
	readonly inputFileId: string
	readonly total: number
	readonly completionWindow?: string
	readonly now: number
}): BatchMeta {
	return {
		id: input.id,
		object: "batch",
		endpoint: input.endpoint,
		input_file_id: input.inputFileId,
		completion_window: input.completionWindow ?? "24h",
		status: "validating",
		created_at: input.now,
		request_counts: { total: input.total, completed: 0, failed: 0 },
	}
}
