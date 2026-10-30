/**
 * The translator dump files, tested where the traversal rule is enforced.
 *
 * `tests/unit/translator-rules.test.ts` already covers `translatorDumpFile` itself — every case
 * below says what the *use-case* does with a refused name: it must not reach the store, on either
 * verb, whatever arrived. That is the property the route depends on, and nothing tested it before.
 */

import {
	loadDump,
	saveDump,
	type TranslatorDumpStore,
} from "9router-api/application/translator/read-translator-dumps"
import { TRANSLATOR_DUMP_FILES, translatorDumpFile } from "9router-api/domain/translator"
import { describe, expect, it, vi } from "vitest"

function store(files: Record<string, string> = {}) {
	const written: Array<[string, string]> = []
	const reads: string[] = []
	const port: TranslatorDumpStore = {
		read: (file) => {
			reads.push(file)
			return files[file] ?? null
		},
		write: (file, content) => {
			written.push([file, content])
		},
	}
	return Object.assign(port, { written, reads })
}

const hostile = [
	"../../etc/passwd",
	"../../../root/.ssh/id_rsa",
	"/etc/passwd",
	"..%2f..%2fetc%2fpasswd",
	"logs/translator/1_req_client.json",
	".",
	"..",
	"",
	null,
	undefined,
	"a\u0000b",
] as const

describe("a refused name never reaches the filesystem", () => {
	it.each(hostile)("load refuses %j and reads nothing", async (name) => {
		const s = store()
		const answer = await loadDump(name, translatorDumpFile, s)
		expect(answer.status).toBe(400)
		expect(s.reads).toEqual([])
	})

	it.each(hostile)("save refuses %j and writes nothing", async (name) => {
		const s = store()
		const answer = await saveDump({ file: name, content: "x" }, translatorDumpFile, s)
		expect(answer.status).toBe(400)
		expect(s.written).toEqual([])
	})

	it("refuses every name outside the whitelist", async () => {
		const s = store()
		for (const name of ["1_req_client.json ", "8_req_extra.json", "1_REQ_CLIENT.JSON"]) {
			const answer = await loadDump(name, translatorDumpFile, s)
			expect(answer.status).toBe(400)
		}
		expect(s.reads).toEqual([])
	})
})

describe("loading a capture", () => {
	it("returns the content for every documented dump file", async () => {
		const name = TRANSLATOR_DUMP_FILES[0]
		const answer = await loadDump(name, translatorDumpFile, store({ [name]: "{}" }))
		expect(answer.status).toBe(200)
		expect(answer.body).toEqual({ success: true, content: "{}" })
	})

	it("answers 404 — not 400 — when an accepted name has no file", async () => {
		const answer = await loadDump(TRANSLATOR_DUMP_FILES[0], translatorDumpFile, store())
		expect(answer.status).toBe(404)
	})

	it("answers 500 with the reason when the read throws", async () => {
		const answer = await loadDump(TRANSLATOR_DUMP_FILES[0], translatorDumpFile, {
			read: () => {
				throw new Error("EACCES")
			},
			write: vi.fn(),
		})
		expect(answer.status).toBe(500)
		expect(answer.body.error).toBe("EACCES")
	})
})

describe("saving a capture", () => {
	it("writes the accepted name", async () => {
		const s = store()
		const name = TRANSLATOR_DUMP_FILES[0]
		const answer = await saveDump({ file: name, content: "hello" }, translatorDumpFile, s)
		expect(answer.status).toBe(200)
		expect(s.written).toEqual([[name, "hello"]])
	})

	it('requires content rather than writing the string "undefined"', async () => {
		const s = store()
		const answer = await saveDump({ file: TRANSLATOR_DUMP_FILES[0] }, translatorDumpFile, s)
		expect(answer.status).toBe(400)
		expect(answer.body.error).toBe("Content required")
		expect(s.written).toEqual([])
	})

	it("accepts empty content, which is a legitimate empty capture", async () => {
		const s = store()
		const answer = await saveDump(
			{ file: TRANSLATOR_DUMP_FILES[0], content: "" },
			translatorDumpFile,
			s,
		)
		expect(answer.status).toBe(200)
		expect(s.written).toEqual([[TRANSLATOR_DUMP_FILES[0], ""]])
	})

	it("answers 500 with the reason when the write throws", async () => {
		const answer = await saveDump(
			{ file: TRANSLATOR_DUMP_FILES[0], content: "x" },
			translatorDumpFile,
			{
				read: vi.fn(),
				write: () => {
					throw new Error("ENOSPC")
				},
			},
		)
		expect(answer.status).toBe(500)
		expect(answer.body.error).toBe("ENOSPC")
	})
})
