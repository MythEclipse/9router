import { describe, expect, test } from "vitest"
import {
	changelogIsUsable,
	changelogPayload,
	LOCAL_CHANGELOG_FILENAME,
	OFFICIAL_CHANGELOG_URL,
} from "../../apps/api/src/domain/changelog-source"

describe("changelogIsUsable", () => {
	test("whitespace is the same as no file", () => {
		// The modal would otherwise render an empty pane under a heading.
		expect(changelogIsUsable("   \n\t ")).toBe(false)
		expect(changelogIsUsable("")).toBe(false)
		expect(changelogIsUsable(null)).toBe(false)
		expect(changelogIsUsable(undefined)).toBe(false)
	})

	test("real markdown counts", () => {
		expect(changelogIsUsable("# Changelog")).toBe(true)
	})
})

describe("changelogPayload", () => {
	test("both panes survive together — one missing does not hide the other", () => {
		expect(changelogPayload("# mine", "# upstream")).toEqual({
			ok: true,
			official: "# upstream",
			custom: "# mine",
		})
	})

	test("the local copy alone is enough", () => {
		expect(changelogPayload("# mine", null)).toEqual({
			ok: true,
			official: null,
			custom: "# mine",
		})
	})

	test("upstream alone is enough", () => {
		expect(changelogPayload(null, "# upstream")).toEqual({
			ok: true,
			official: "# upstream",
			custom: null,
		})
	})

	test("neither source is ok:false with both null, not an error", () => {
		// A cosmetic feature must not look like an outage.
		expect(changelogPayload(null, undefined)).toEqual({ ok: false, official: null, custom: null })
	})

	test("a blank body is reported as null rather than shipped as whitespace", () => {
		expect(changelogPayload("   ", "  \n ")).toEqual({
			ok: false,
			official: null,
			custom: null,
		})
	})
})

describe("source constants", () => {
	test("the local file is the one the release process writes", () => {
		expect(LOCAL_CHANGELOG_FILENAME).toBe("CHANGELOG.md")
	})

	test("upstream is this project's own raw changelog", () => {
		expect(OFFICIAL_CHANGELOG_URL).toContain("raw.githubusercontent.com")
		expect(OFFICIAL_CHANGELOG_URL.endsWith("CHANGELOG.md")).toBe(true)
	})
})
