/**
 * `/v1/batches`: the four ways an async job lies about itself.
 *
 * A status that moves backwards, a half-parsed input file, a batch that finishes with lines
 * unaccounted for, and a cancel that leaves a request running.
 */

import {
	type BatchDispatch,
	type BatchFiles,
	type BatchStore,
	makeBatches,
	type StoredBatchRecord,
} from "9router-api/application/batches/batches"
import {
	batchIdOf,
	batchMetaOf,
	endpointOf,
	errorLineOf,
	mayTransition,
	outputLineOf,
	parseBatchLines,
} from "9router-api/domain/openai-batches"
import { describe, expect, it } from "vitest"

describe("mayTransition", () => {
	it("allows the lifecycle a batch actually walks", () => {
		expect(mayTransition("validating", "in_progress")).toBe(true)
		expect(mayTransition("in_progress", "finalizing")).toBe(true)
		expect(mayTransition("finalizing", "completed")).toBe(true)
	})

	it("refuses to reopen a finished batch", () => {
		expect(mayTransition("completed", "in_progress")).toBe(false)
		expect(mayTransition("cancelled", "in_progress")).toBe(false)
		expect(mayTransition("failed", "in_progress")).toBe(false)
	})
})

describe("endpointOf", () => {
	it("accepts the two endpoints that answer one body per line", () => {
		expect(endpointOf("/v1/chat/completions")).toBe("/v1/chat/completions")
		expect(endpointOf("/v1/responses")).toBe("/v1/responses")
	})

	it("refuses an endpoint the gateway cannot batch", () => {
		expect(endpointOf("/v1/images/generations")).toBeNull()
		expect(endpointOf("")).toBeNull()
		expect(endpointOf(undefined)).toBeNull()
	})
})

describe("parseBatchLines", () => {
	const line = (id: string) => JSON.stringify({ custom_id: id, body: { model: "m", messages: [] } })

	it("parses a well-formed file and skips the trailing blank line", () => {
		const parsed = parseBatchLines(`${line("a")}\n${line("b")}\n`)

		expect("lines" in parsed && parsed.lines.map((entry) => entry.custom_id)).toEqual(["a", "b"])
	})

	it("refuses a line that is not JSON, naming it", () => {
		const parsed = parseBatchLines(`${line("a")}\nnot json`)

		expect(parsed).toEqual({ error: "line 2 is not valid JSON" })
	})

	it("refuses a line with no custom_id, because its result could never be matched", () => {
		const parsed = parseBatchLines(JSON.stringify({ body: { model: "m" } }))

		expect(parsed).toEqual({ error: "line 1 has no custom_id" })
	})

	it("refuses duplicate custom_ids, which would collapse two results into one", () => {
		const parsed = parseBatchLines(`${line("a")}\n${line("a")}`)

		expect(parsed).toEqual({ error: 'duplicate custom_id "a"' })
	})

	it("refuses an empty file", () => {
		expect(parseBatchLines("\n\n")).toEqual({ error: "the input file holds no request lines" })
	})
})

describe("outputLineOf", () => {
	it("keys the result by custom_id, the way the output file is read", () => {
		const parsed = JSON.parse(outputLineOf("a", 200, { ok: true }))

		expect(parsed).toMatchObject({ custom_id: "a", response: { status_code: 200 } })
	})

	it("records a failed request as an error line, not as a result", () => {
		const parsed = JSON.parse(errorLineOf("a", "gateway answered 502"))

		expect(parsed.error).toMatchObject({ code: "request_failed" })
		expect(parsed.response.body).toBeNull()
	})
})

describe("batchIdOf", () => {
	it("uses the prefix clients parse", () => {
		expect(batchIdOf(() => new Uint8Array(12).fill(0x0f))).toBe(`batch_${"0f".repeat(12)}`)
	})
})

describe("batchMetaOf", () => {
	it("starts in validating with an empty count", () => {
		const meta = batchMetaOf({
			id: "batch_1",
			endpoint: "/v1/chat/completions",
			inputFileId: "file-1",
			total: 3,
			now: 1,
		})

		expect(meta.status).toBe("validating")
		expect(meta.request_counts).toEqual({ total: 3, completed: 0, failed: 0 })
		expect(meta.completion_window).toBe("24h")
	})
})

/** An in-memory store and file bridge. */
function harness(lines: string, options: { failIds?: string[] } = {}) {
	const records = new Map<string, StoredBatchRecord>()
	const written = new Map<string, string>()

	const store: BatchStore = {
		put: async (id, record) => {
			records.set(id, JSON.parse(JSON.stringify(record)))
		},
		get: async (id) => records.get(id) ?? null,
		list: async () => [...records.values()].map((record) => record.meta),
	}

	const files: BatchFiles = {
		read: async () => ({ text: lines }),
		write: async (filename, text) => {
			const id = `file-${written.size + 1}`
			written.set(filename, text)
			return { id }
		},
	}

	let call = 0
	const dispatch: BatchDispatch = async () => {
		const index = call++
		if (options.failIds?.includes(String(index))) throw new Error("upstream exploded")
		return { status: 200, body: { ok: index } }
	}

	return { store, files, dispatch, records, written }
}

const twoLines = [
	JSON.stringify({ custom_id: "a", body: { model: "m" } }),
	JSON.stringify({ custom_id: "b", body: { model: "m" } }),
].join("\n")

describe("makeBatches", () => {
	it("creates a batch from a file and counts its lines", async () => {
		const { store, files } = harness(twoLines)
		const batch = await makeBatches(store, files).create({
			inputFileId: "file-1",
			endpoint: "/v1/chat/completions",
		})

		expect(batch.status).toBe("validating")
		expect(batch.request_counts.total).toBe(2)
	})

	it("refuses an endpoint it cannot batch", async () => {
		const { store, files } = harness(twoLines)

		await expect(
			makeBatches(store, files).create({ inputFileId: "file-1", endpoint: "/v1/embeddings" }),
		).rejects.toMatchObject({ code: "VALIDATION" })
	})

	it("refuses an input file it cannot read", async () => {
		const { store } = harness(twoLines)
		const files: BatchFiles = { read: async () => null, write: async () => ({ id: "x" }) }

		await expect(
			makeBatches(store, files).create({ inputFileId: "file-gone", endpoint: "/v1/chat/completions" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" })
	})

	it("runs the batch to completion and writes both result files", async () => {
		const { store, files, dispatch, written } = harness(twoLines)
		const useCase = makeBatches(store, files)
		const created = await useCase.create({ inputFileId: "file-1", endpoint: "/v1/chat/completions" })
		const finished = await useCase.run(created.id, dispatch)

		expect(finished.status).toBe("completed")
		expect(finished.request_counts).toEqual({ total: 2, completed: 2, failed: 0 })
		expect(finished.output_file_id).toBeDefined()
		expect(written.get(`batch-${created.id}-output.jsonl`)?.split("\n")).toHaveLength(2)
	})

	it("keeps going when one line fails, and records it in the error file", async () => {
		const { store, files, dispatch } = harness(twoLines, { failIds: ["0"] })
		const useCase = makeBatches(store, files)
		const created = await useCase.create({ inputFileId: "file-1", endpoint: "/v1/chat/completions" })
		const finished = await useCase.run(created.id, dispatch)

		expect(finished.request_counts).toEqual({ total: 2, completed: 1, failed: 1 })
		expect(finished.error_file_id).toBeDefined()
		expect(finished.status).toBe("completed")
	})

	it("advances by at most batchSize per run, and stays in_progress", async () => {
		const three = [1, 2, 3]
			.map((n) => JSON.stringify({ custom_id: `c${n}`, body: { model: "m" } }))
			.join("\n")
		const { store, files, dispatch } = harness(three)
		const useCase = makeBatches(store, files)
		const created = await useCase.create({ inputFileId: "file-1", endpoint: "/v1/chat/completions" })

		const first = await useCase.run(created.id, dispatch, { batchSize: 1 })

		expect(first.status).toBe("in_progress")
		expect(first.request_counts.completed).toBe(1)
	})

	it("stops a cancelled batch instead of finishing it", async () => {
		const { store, files, dispatch } = harness(twoLines)
		const useCase = makeBatches(store, files)
		const created = await useCase.create({ inputFileId: "file-1", endpoint: "/v1/chat/completions" })
		await useCase.cancel(created.id)

		const after = await useCase.run(created.id, dispatch)

		expect(after.status).toBe("cancelled")
		expect(after.request_counts.completed).toBe(0)
	})

	it("refuses to reopen a completed batch on a late tick", async () => {
		const { store, files, dispatch } = harness(twoLines)
		const useCase = makeBatches(store, files)
		const created = await useCase.create({ inputFileId: "file-1", endpoint: "/v1/chat/completions" })
		await useCase.run(created.id, dispatch)

		const again = await useCase.run(created.id, dispatch)

		expect(again.status).toBe("completed")
		expect(again.request_counts.completed).toBe(2)
	})

	it("answers 404 for a batch id it does not hold", async () => {
		const { store, files } = harness(twoLines)

		await expect(makeBatches(store, files).get("batch_missing")).rejects.toMatchObject({
			code: "NOT_FOUND",
		})
	})
})
