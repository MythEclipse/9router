/**
 * The batch store and its file bridge.
 *
 * Output files are ordinary uploads — purpose `batch`, the same shape `/v1/files` serves — so a
 * client that knows how to download a file already knows how to collect a batch result.
 */
import { getBatch, listBatches, putBatch } from "@9router/db/repos/batchesRepo"
import { getFile, putFile } from "@9router/db/repos/filesRepo"
import type {
	BatchFiles,
	BatchStore,
	StoredBatchRecord,
} from "../../application/batches/batches.ts"
import { fileIdOf, fileMetaOf } from "../../domain/openai-files.ts"

export function batchStore(): BatchStore {
	return {
		put: (id, record: StoredBatchRecord) => putBatch(id, record),
		get: getBatch,
		list: listBatches,
	}
}

export function batchFiles(): BatchFiles {
	return {
		async read(id) {
			const stored = await getFile(id)
			if (!stored) return null
			return { text: new TextDecoder().decode(stored.bytes) }
		},

		async write(filename, text) {
			const bytes = new TextEncoder().encode(text)
			const meta = fileMetaOf({
				id: fileIdOf(() => crypto.getRandomValues(new Uint8Array(12))),
				filename,
				purpose: "batch",
				bytes: bytes.byteLength,
				contentType: "application/jsonl",
				now: Date.now(),
			})
			await putFile(meta.id, { ...meta }, bytes)
			return { id: meta.id }
		},
	}
}
