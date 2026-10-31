/**
 * The `/v1/files` shape: what OpenAI's file object is, and what a stored upload may not be.
 *
 * Three refusals, each of them a way an upload endpoint goes wrong:
 *
 * 1. **A filename that is a path.** `../../etc/passwd` as a display name is harmless until
 *    something writes it to disk, and `"CON"` breaks on Windows. The name is sanitised to a
 *    basename with no control characters, and the stored id — never the name — is the key.
 * 2. **A purpose nobody supports.** An arbitrary purpose string is accepted by the real API only
 *    in a closed set; accepting anything means a typo looks like a stored file that no endpoint
 *    will ever read.
 * 3. **A size the store cannot hold.** The cap is enforced here, before a byte is encoded, so an
 *    oversized upload fails with a reason instead of a truncated record.
 */

/** Purposes the OpenAI file API accepts. */
export const FILE_PURPOSES = [
	"assistants",
	"batch",
	"fine-tune",
	"vision",
	"user_data",
	"responses",
] as const

export type FilePurpose = (typeof FILE_PURPOSES)[number]

/**
 * The largest upload accepted, in bytes.
 *
 * Eight megabytes: large enough for a screenshot or a JSONL batch, small enough that the record
 * stays a single row. The real API takes gigabytes because it streams to object storage; this
 * store does not.
 */
export const MAX_FILE_BYTES = 8 * 1024 * 1024

/** The file object as the OpenAI API reports it. */
export interface FileMeta {
	readonly id: string
	readonly object: "file"
	readonly bytes: number
	readonly createdAt: number
	readonly filename: string
	readonly purpose: string
	readonly contentType?: string
}

/** Why an upload was refused. */
export type UploadRefusal = "empty" | "too-large" | "bad-purpose" | "missing-filename"

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g

/**
 * A display name that is safe to store and echo.
 *
 * Path separators and control characters are stripped rather than escaped: the name is cosmetic
 * — the id is the key — so a mangled name is better than a name that traverses.
 */
export function sanitizeFilename(value: unknown): string {
	if (typeof value !== "string") return ""
	const base = value.split(/[/\\]/).pop() ?? ""
	const cleaned = base.replace(CONTROL_CHARS, "").trim()
	return cleaned.slice(0, 255)
}

/** The purpose, or `null` when it is not one the API accepts. */
export function purposeOf(value: unknown): FilePurpose | null {
	if (typeof value !== "string") return null
	return (FILE_PURPOSES as readonly string[]).includes(value) ? (value as FilePurpose) : null
}

/**
 * A file id.
 *
 * Prefixed `file-` because that is what clients parse, and derived from random bytes rather than
 * a counter: two uploads in the same millisecond must not collide, and an id is not a sequence
 * anyone should be able to walk.
 */
export function fileIdOf(random: () => Uint8Array): string {
	const bytes = random()
	const hex = Array.from(bytes.slice(0, 12), (byte) => byte.toString(16).padStart(2, "0")).join("")
	return `file-${hex}`
}

/** The refusal for an upload, or `null` when it may be stored. */
export function refusalOf(input: {
	readonly filename: unknown
	readonly purpose: unknown
	readonly bytes: number
}): UploadRefusal | null {
	if (sanitizeFilename(input.filename) === "") return "missing-filename"
	if (purposeOf(input.purpose) === null) return "bad-purpose"
	if (!Number.isFinite(input.bytes) || input.bytes <= 0) return "empty"
	if (input.bytes > MAX_FILE_BYTES) return "too-large"
	return null
}

/** The stored object's metadata. */
export function fileMetaOf(input: {
	readonly id: string
	readonly filename: string
	readonly purpose: string
	readonly bytes: number
	readonly contentType?: string
	readonly now: number
}): FileMeta {
	return {
		id: input.id,
		object: "file",
		bytes: input.bytes,
		createdAt: input.now,
		filename: sanitizeFilename(input.filename),
		purpose: input.purpose,
		...(input.contentType ? { contentType: input.contentType } : {}),
	}
}
