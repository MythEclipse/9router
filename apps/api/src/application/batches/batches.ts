/**
 * `/v1/batches`: turn an uploaded JSONL file into results, without holding a connection open.
 *
 * The gateway is a request-response process, not a job runner, so this is deliberately explicit
 * about how work advances: `create` validates and stores the job, and `run` performs up to
 * `batchSize` requests and records their results. Whoever calls `run` — the route right after
 * `create`, a cron, an operator — decides when the work happens. A batch left unrun sits at
 * `in_progress` with its counts visible, which is the truth.
 *
 * Four rules that keep the state honest:
 *
 * 1. **A status only moves forward.** `mayTransition` guards every write; a late tick that would
 *    reopen a finished job is dropped.
 * 2. **Cancelling is honoured between requests, not during one.** A request in flight finishes,
 *    because aborting it would leave a provider charge with no recorded result.
 * 3. **A failed line lands in the error file, and the batch keeps going.** One 500 in a batch of
 *    fifty must not cost the other forty-nine.
 * 4. **Completion means the counts add up.** `finalizing` is written only when every line has an
 *    output or an error line.
 */
import { AppError, notFound } from "../../domain/errors.ts"
import {
	BATCH_STATES,
	type BatchMeta,
	batchIdOf,
	batchMetaOf,
	endpointOf,
	errorLineOf,
	MAX_BATCH_LINES,
	mayTransition,
	outputLineOf,
	parseBatchLines,
} from "../../domain/openai-batches.ts"

export interface BatchStore {
	readonly put: (id: string, record: StoredBatchRecord) => Promise<void>
	readonly get: (id: string) => Promise<StoredBatchRecord | null>
	readonly list: () => Promise<Record<string, unknown>[]>
}

/** What a stored batch holds; the lines stay until the job finishes. */
export interface StoredBatchRecord {
	meta: Record<string, unknown>
	lines: Array<{ custom_id: string; body: unknown }>
	output: string[]
	errors: string[]
}

/** Reads and writes the JSONL files the batch points at. */
export interface BatchFiles {
	readonly read: (id: string) => Promise<{ text: string } | null>
	readonly write: (filename: string, text: string) => Promise<{ id: string }>
}

/** Performs one request and answers its status and body. Must not throw for a 4xx/5xx. */
export type BatchDispatch = (
	body: unknown,
	endpoint: string,
) => Promise<{ status: number; body: unknown }>

export interface BatchesUseCase {
	readonly create: (input: {
		readonly inputFileId: string
		readonly endpoint: unknown
		readonly completionWindow?: unknown
	}) => Promise<BatchMeta>
	readonly get: (id: string) => Promise<BatchMeta>
	readonly list: () => Promise<{ object: "list"; data: BatchMeta[] }>
	readonly cancel: (id: string) => Promise<BatchMeta>
	/** Advance a batch by at most `batchSize` requests. */
	readonly run: (
		id: string,
		dispatch: BatchDispatch,
		options?: { readonly batchSize?: number },
	) => Promise<BatchMeta>
}

const asMeta = (record: StoredBatchRecord): BatchMeta => record.meta as unknown as BatchMeta

const stateOf = (record: StoredBatchRecord): BatchMeta["status"] => asMeta(record).status

/** How many requests one `run` performs by default. */
const DEFAULT_BATCH_SIZE = 10

export function makeBatches(
	store: BatchStore,
	files: BatchFiles,
	options: {
		readonly now?: () => number
		readonly random?: () => Uint8Array
		/** Bounds concurrent outbound work; the batch runner is what can saturate it. */
		readonly gate?: { run: <T>(work: () => Promise<T>) => Promise<T> }
	} = {},
): BatchesUseCase {
	const now = options.now ?? (() => Date.now())
	const random = options.random ?? (() => crypto.getRandomValues(new Uint8Array(12)))

	/** A state change that refuses to move backwards. */
	function transition(
		record: StoredBatchRecord,
		to: BatchMeta["status"],
		stamp?: Partial<BatchMeta>,
	) {
		const from = stateOf(record)
		if (!mayTransition(from, to)) {
			throw new AppError("CONFLICT", `A batch cannot move from ${from} to ${to}`, {
				data: { from, to },
			})
		}
		record.meta = { ...record.meta, ...(stamp ?? {}), status: to }
	}

	return {
		async create(input) {
			const endpoint = endpointOf(input.endpoint)
			if (!endpoint) {
				throw new AppError("VALIDATION", "endpoint must be /v1/chat/completions or /v1/responses")
			}

			const file = await files.read(input.inputFileId)
			if (!file) throw notFound(`File ${input.inputFileId}`)

			const parsed = parseBatchLines(file.text)
			if ("error" in parsed) throw new AppError("VALIDATION", parsed.error)

			const meta = batchMetaOf({
				id: batchIdOf(random),
				endpoint,
				inputFileId: input.inputFileId,
				total: parsed.lines.length,
				completionWindow:
					typeof input.completionWindow === "string" ? input.completionWindow : undefined,
				now: now(),
			})

			await store.put(meta.id, {
				meta: { ...meta },
				lines: parsed.lines.map((line) => ({ custom_id: line.custom_id, body: line.body })),
				output: [],
				errors: [],
			})

			return meta
		},

		async get(id) {
			const record = await store.get(id)
			if (!record) throw notFound(`Batch ${id}`)
			return asMeta(record)
		},

		async list() {
			const rows = await store.list()
			return { object: "list", data: rows as unknown as BatchMeta[] }
		},

		async cancel(id) {
			const record = await store.get(id)
			if (!record) throw notFound(`Batch ${id}`)

			const state = stateOf(record)
			// A job that has not started is cancelled outright; one mid-flight stops between
			// requests, which `run` notices before its next dispatch.
			if (state === "validating" || state === "in_progress") {
				transition(record, "cancelling", { cancelled_at: now() })
				transition(record, "cancelled", { cancelled_at: now() })
				await store.put(id, record)
			}

			return asMeta(record)
		},

		async run(id, dispatch, runOptions = {}) {
			const record = await store.get(id)
			if (!record) throw notFound(`Batch ${id}`)

			const state = stateOf(record)
			if (state === "validating") transition(record, "in_progress", { in_progress_at: now() })
			if (stateOf(record) !== "in_progress") {
				// Completed, cancelled, or failed: nothing to advance, and nothing to reopen.
				return asMeta(record)
			}

			const endpoint = asMeta(record).endpoint
			const done = new Set([
				...record.output.map((line) => String(JSON.parse(line).custom_id)),
				...record.errors.map((line) => String(JSON.parse(line).custom_id)),
			])
			const pending = record.lines.filter((line) => !done.has(line.custom_id))
			const slice = pending.slice(0, runOptions.batchSize ?? DEFAULT_BATCH_SIZE)

			for (const line of slice) {
				// Re-read the state so a cancel that landed mid-run stops the next request.
				const latest = await store.get(id)
				if (!latest || stateOf(latest) !== "in_progress") break

				try {
					const call = () => dispatch(line.body, endpoint)
					const answer = await (options.gate ? options.gate.run(call) : call())
					if (answer.status >= 400) {
						latest.errors.push(errorLineOf(line.custom_id, `gateway answered ${answer.status}`))
					} else {
						latest.output.push(outputLineOf(line.custom_id, answer.status, answer.body))
					}
				} catch (error) {
					latest.errors.push(
						errorLineOf(line.custom_id, error instanceof Error ? error.message : "request failed"),
					)
				}

				const completed = latest.output.length
				const failed = latest.errors.length
				latest.meta = {
					...latest.meta,
					request_counts: { total: latest.lines.length, completed, failed },
				}
				await store.put(id, latest)
			}

			const latest = await store.get(id)
			if (!latest) throw notFound(`Batch ${id}`)
			if (stateOf(latest) !== "in_progress") return asMeta(latest)

			const finished = latest.output.length + latest.errors.length
			if (finished < latest.lines.length) return asMeta(latest)

			// Every line has an answer: write the files, then close the job.
			transition(latest, "finalizing")
			await store.put(id, latest)

			if (latest.output.length > 0) {
				const written = await files.write(`batch-${id}-output.jsonl`, latest.output.join("\n"))
				latest.meta = { ...latest.meta, output_file_id: written.id }
			}
			if (latest.errors.length > 0) {
				const written = await files.write(`batch-${id}-errors.jsonl`, latest.errors.join("\n"))
				latest.meta = { ...latest.meta, error_file_id: written.id }
			}

			transition(latest, "completed", { completed_at: now() })
			await store.put(id, latest)
			return asMeta(latest)
		},
	}
}

/** The states a caller may ask about; exported so a route can validate a filter. */
export const BATCH_STATE_NAMES = BATCH_STATES
export const BATCH_LINE_LIMIT = MAX_BATCH_LINES
