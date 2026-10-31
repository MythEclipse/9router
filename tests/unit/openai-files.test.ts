/**
 * `/v1/files`: the four ways an upload endpoint becomes a liability.
 *
 * A filename that is a path, a purpose nobody supports, a size the store cannot hold, and a
 * read that answers silence for a mistyped id.
 */

import { type FileStore, makeFiles } from "9router-api/application/files/files"
import {
	FILE_PURPOSES,
	fileIdOf,
	fileMetaOf,
	MAX_FILE_BYTES,
	purposeOf,
	refusalOf,
	sanitizeFilename,
} from "9router-api/domain/openai-files"
import { describe, expect, it } from "vitest"

describe("sanitizeFilename", () => {
	it("keeps a basename and drops the directory part", () => {
		expect(sanitizeFilename("../../etc/passwd")).toBe("passwd")
		expect(sanitizeFilename("C:\\Users\\me\\shot.png")).toBe("shot.png")
	})

	it("strips control characters that would break a header", () => {
		expect(sanitizeFilename("bad\u0000name\u001f.png")).toBe("badname.png")
	})

	it("answers an empty name for a value that is not a name", () => {
		expect(sanitizeFilename(null)).toBe("")
		expect(sanitizeFilename(42)).toBe("")
		expect(sanitizeFilename("   ")).toBe("")
	})

	it("caps the length so a header stays a header", () => {
		expect(sanitizeFilename("a".repeat(400)).length).toBe(255)
	})
})

describe("purposeOf", () => {
	it("accepts every documented purpose", () => {
		for (const purpose of FILE_PURPOSES) expect(purposeOf(purpose)).toBe(purpose)
	})

	it("refuses a purpose outside the set, so a typo is not a stored orphan", () => {
		expect(purposeOf("assistant")).toBeNull()
		expect(purposeOf("")).toBeNull()
		expect(purposeOf(undefined)).toBeNull()
	})
})

describe("fileIdOf", () => {
	it("prefixes the id the way clients parse it, and derives it from random bytes", () => {
		const id = fileIdOf(() => new Uint8Array(12).fill(0xab))

		expect(id).toBe(`file-${"ab".repeat(12)}`)
	})

	it("answers a different id for different bytes", () => {
		const first = fileIdOf(() => new Uint8Array(12).fill(1))
		const second = fileIdOf(() => new Uint8Array(12).fill(2))

		expect(first).not.toBe(second)
	})
})

describe("refusalOf", () => {
	const base = { filename: "a.png", purpose: "vision", bytes: 10 }

	it("accepts a well-formed upload", () => {
		expect(refusalOf(base)).toBeNull()
	})

	it("refuses an empty file", () => {
		expect(refusalOf({ ...base, bytes: 0 })).toBe("empty")
	})

	it("refuses a file past the cap, before a byte is encoded", () => {
		expect(refusalOf({ ...base, bytes: MAX_FILE_BYTES + 1 })).toBe("too-large")
		expect(refusalOf({ ...base, bytes: MAX_FILE_BYTES })).toBeNull()
	})

	it("refuses an unsupported purpose and a missing name", () => {
		expect(refusalOf({ ...base, purpose: "nope" })).toBe("bad-purpose")
		expect(refusalOf({ ...base, filename: "" })).toBe("missing-filename")
	})
})

describe("fileMetaOf", () => {
	it("reports the OpenAI file shape", () => {
		const meta = fileMetaOf({
			id: "file-1",
			filename: "shot.png",
			purpose: "vision",
			bytes: 12,
			contentType: "image/png",
			now: 1_700_000_000_000,
		})

		expect(meta).toMatchObject({ object: "file", bytes: 12, filename: "shot.png", purpose: "vision" })
	})

	it("omits the content type when there is none, rather than storing an empty string", () => {
		const meta = fileMetaOf({ id: "file-1", filename: "a", purpose: "vision", bytes: 1, now: 0 })

		expect("contentType" in meta).toBe(false)
	})
})

/** An in-memory store, so the use-case is tested without a database. */
function store(): FileStore & { rows: Map<string, Uint8Array> } {
	const rows = new Map<string, Uint8Array>()
	const metas = new Map<string, Record<string, unknown>>()
	return {
		rows,
		put: async (id, meta, bytes) => {
			metas.set(id, meta)
			rows.set(id, bytes)
		},
		get: async (id) => {
			const bytes = rows.get(id)
			const meta = metas.get(id)
			return bytes && meta ? { meta, bytes } : null
		},
		list: async () => [...metas.values()],
		remove: async (id) => {
			const had = rows.delete(id)
			metas.delete(id)
			return had
		},
	}
}

const upload = (over: Partial<Parameters<ReturnType<typeof makeFiles>["upload"]>[0]> = {}) => ({
	filename: "shot.png",
	purpose: "vision",
	contentType: "image/png",
	bytes: new Uint8Array([1, 2, 3]),
	...over,
})

describe("makeFiles", () => {
	it("stores an upload and answers its metadata", async () => {
		const port = store()
		const meta = await makeFiles(port).upload(upload())

		expect(meta.id.startsWith("file-")).toBe(true)
		expect(meta.bytes).toBe(3)
		expect(port.rows.size).toBe(1)
	})

	it("refuses an oversize upload with a 413, not a truncated row", async () => {
		const port = store()
		const big = new Uint8Array(MAX_FILE_BYTES + 1)

		await expect(makeFiles(port).upload(upload({ bytes: big }))).rejects.toMatchObject({
			code: "PAYLOAD_TOO_LARGE",
		})
		expect(port.rows.size).toBe(0)
	})

	it("refuses an empty upload", async () => {
		await expect(
			makeFiles(store()).upload(upload({ bytes: new Uint8Array(0) })),
		).rejects.toMatchObject({ code: "VALIDATION" })
	})

	it("refuses an unsupported purpose", async () => {
		await expect(makeFiles(store()).upload(upload({ purpose: "assistant" }))).rejects.toMatchObject({
			code: "VALIDATION",
		})
	})

	it("reads back the exact bytes it stored", async () => {
		const useCase = makeFiles(store())
		const meta = await useCase.upload(upload())
		const { bytes } = await useCase.content(meta.id)

		expect(Array.from(bytes)).toEqual([1, 2, 3])
	})

	it("answers 404 for an id it never stored", async () => {
		await expect(makeFiles(store()).content("file-missing")).rejects.toMatchObject({
			code: "NOT_FOUND",
		})
	})

	it("lists what it stored, and answers the OpenAI list shape", async () => {
		const useCase = makeFiles(store())
		await useCase.upload(upload())
		const list = await useCase.list()

		expect(list.object).toBe("list")
		expect(list.data).toHaveLength(1)
	})

	it("deletes once and reports the second attempt as not found", async () => {
		const useCase = makeFiles(store())
		const meta = await useCase.upload(upload())

		expect(await useCase.remove(meta.id)).toMatchObject({ deleted: true })
		await expect(useCase.remove(meta.id)).rejects.toMatchObject({ code: "NOT_FOUND" })
	})
})
