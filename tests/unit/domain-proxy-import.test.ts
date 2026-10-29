import { describe, expect, it } from "vitest"
import {
	IMPORT_POLL_MS,
	importRefusalOf,
	MAX_REPORTED_ENTRY_ERRORS,
	readImportEntries,
} from "../../apps/api/src/domain/proxy-import.ts"

describe("readImportEntries", () => {
	it("keeps the rows that name a pool and an absolute http(s) URL", () => {
		const { entries, errors } = readImportEntries([
			{ name: "a", proxyUrl: "http://1.2.3.4:8080" },
			{ name: "b", proxyUrl: "https://proxy.example" },
		])
		expect(entries).toEqual([
			{ name: "a", proxyUrl: "http://1.2.3.4:8080" },
			{ name: "b", proxyUrl: "https://proxy.example" },
		])
		expect(errors).toEqual([])
	})

	it("trims both fields", () => {
		const { entries } = readImportEntries([{ name: " a ", proxyUrl: " http://h:1 " }])
		expect(entries).toEqual([{ name: "a", proxyUrl: "http://h:1" }])
	})

	it("refuses a bare host:port, which the pool table would accept and then fail on", () => {
		const { entries, errors } = readImportEntries([{ name: "a", proxyUrl: "1.2.3.4:8080" }])
		expect(entries).toEqual([])
		expect(errors).toEqual(["Entry 1: missing name or http(s) proxyUrl"])
	})

	it("refuses a nameless row and a url-less row, numbering from one", () => {
		const { errors } = readImportEntries([
			{ name: "", proxyUrl: "http://h:1" },
			{ name: "b" },
			{},
			null,
		])
		expect(errors).toEqual([
			"Entry 1: missing name or http(s) proxyUrl",
			"Entry 2: missing name or http(s) proxyUrl",
			"Entry 3: missing name or http(s) proxyUrl",
			"Entry 4: missing name or http(s) proxyUrl",
		])
	})

	it("keeps the good rows while reporting the bad ones", () => {
		const { entries, errors } = readImportEntries([
			{ name: "good", proxyUrl: "http://h:1" },
			{ name: "", proxyUrl: "http://h:2" },
		])
		expect(entries).toHaveLength(1)
		expect(errors).toHaveLength(1)
	})

	it("treats a non-array as no rows at all", () => {
		expect(readImportEntries("nope")).toEqual({ entries: [], errors: [] })
		expect(readImportEntries(undefined)).toEqual({ entries: [], errors: [] })
	})

	it("accepts an uppercase scheme", () => {
		const { entries } = readImportEntries([{ name: "a", proxyUrl: "HTTP://h:1" }])
		expect(entries).toHaveLength(1)
	})
})

describe("importRefusalOf", () => {
	it("allows a request whose rows all passed", () => {
		expect(importRefusalOf([], [{ name: "a", proxyUrl: "http://h:1" }])).toBeNull()
	})

	it("reports the row errors first, because they say what to fix", () => {
		expect(importRefusalOf(["Entry 1: bad"], [])).toMatch(/^Invalid entries:\nEntry 1: bad$/)
	})

	it("caps the report so a large paste cannot return a wall of text", () => {
		const errors = Array.from({ length: 25 }, (_, i) => `Entry ${i + 1}: bad`)
		const message = importRefusalOf(errors, []) ?? ""
		expect(message.split("\n")).toHaveLength(MAX_REPORTED_ENTRY_ERRORS + 1)
	})

	it("calls an empty list empty, not invalid", () => {
		expect(importRefusalOf([], [])).toBe("Nothing to import")
	})
})

describe("IMPORT_POLL_MS", () => {
	it("is a positive interval the dashboard can schedule against", () => {
		expect(IMPORT_POLL_MS).toBeGreaterThan(0)
	})
})
