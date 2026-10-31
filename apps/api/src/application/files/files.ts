/**
 * The file store, as the `/v1/files` endpoints use it.
 *
 * Refusals carry the same `AppError` codes the rest of the API uses, so a client sees one error
 * shape whether it broke a budget rule or an upload rule. The size check happens twice on
 * purpose: `refusalOf` reports *why* before anything is encoded, and the store's own cap is the
 * backstop for a caller that skipped the use-case.
 */

import { AppError, invalid, notFound, tooLarge } from "../../domain/errors.ts"
import {
	FILE_PURPOSES,
	type FileMeta,
	fileIdOf,
	fileMetaOf,
	MAX_FILE_BYTES,
	purposeOf,
	refusalOf,
	sanitizeFilename,
} from "../../domain/openai-files.ts"

export interface FileStore {
	readonly put: (id: string, meta: Record<string, unknown>, bytes: Uint8Array) => Promise<void>
	readonly get: (id: string) => Promise<{ meta: Record<string, unknown>; bytes: Uint8Array } | null>
	readonly list: () => Promise<Record<string, unknown>[]>
	readonly remove: (id: string) => Promise<boolean>
}

export interface UploadRequest {
	readonly filename: unknown
	readonly purpose: unknown
	readonly contentType?: string | null
	readonly bytes: Uint8Array
}

export interface FilesUseCase {
	readonly upload: (request: UploadRequest) => Promise<FileMeta>
	readonly list: () => Promise<{ object: "list"; data: FileMeta[] }>
	readonly content: (id: string) => Promise<{ meta: FileMeta; bytes: Uint8Array }>
	readonly remove: (id: string) => Promise<{ id: string; object: "file"; deleted: true }>
}

/** Random bytes for an id; injectable so a test can pin it. */
const randomBytes = (): Uint8Array => crypto.getRandomValues(new Uint8Array(12))

const REFUSAL_MESSAGE: Record<string, string> = {
	empty: "The uploaded file is empty",
	"too-large": `The uploaded file exceeds ${MAX_FILE_BYTES} bytes`,
	"bad-purpose": `purpose must be one of ${FILE_PURPOSES.join(", ")}`,
	"missing-filename": "A file needs a name",
}

export function makeFiles(
	store: FileStore,
	options: { readonly now?: () => number; readonly random?: () => Uint8Array } = {},
): FilesUseCase {
	const now = options.now ?? (() => Date.now())
	const random = options.random ?? randomBytes

	return {
		async upload(request) {
			const refusal = refusalOf({
				filename: request.filename,
				purpose: request.purpose,
				bytes: request.bytes.byteLength,
			})

			if (refusal === "too-large") throw tooLarge(REFUSAL_MESSAGE[refusal] ?? "Too large")
			if (refusal === "empty") throw invalid(REFUSAL_MESSAGE[refusal] ?? "Empty file")
			if (refusal) throw invalid(REFUSAL_MESSAGE[refusal] ?? "Invalid upload")

			const purpose = purposeOf(request.purpose)
			if (!purpose) throw invalid("Invalid purpose")

			const meta = fileMetaOf({
				id: fileIdOf(random),
				filename: sanitizeFilename(request.filename),
				purpose,
				bytes: request.bytes.byteLength,
				contentType: request.contentType ?? undefined,
				now: now(),
			})

			await store.put(meta.id, { ...meta }, request.bytes)
			return meta
		},

		async list() {
			const rows = await store.list()
			return { object: "list", data: rows as unknown as FileMeta[] }
		},

		async content(id) {
			const stored = await store.get(id)
			if (!stored) throw notFound(`File ${id}`)
			return { meta: stored.meta as unknown as FileMeta, bytes: stored.bytes }
		},

		async remove(id) {
			const removed = await store.remove(id)
			if (!removed) throw notFound(`File ${id}`)
			return { id, object: "file", deleted: true }
		},
	}
}

export { AppError }
