import { describe, expect, it } from "vitest"
import { resolveLocale } from "../../apps/api/src/domain/locale.ts"

// A miniature of the dashboard's real list; the point of these tests is the
// matching rules, not the catalogue.
const SUPPORTED = ["en", "id", "de", "pt-BR", "pt-PT", "zh-CN", "zh-TW"]

describe("resolveLocale", () => {
	it("accepts an exact supported tag", () => {
		expect(resolveLocale("en", SUPPORTED)).toBe("en")
		expect(resolveLocale("pt-BR", SUPPORTED)).toBe("pt-BR")
	})

	it("ignores case and surrounding space", () => {
		expect(resolveLocale("  PT-br ", SUPPORTED)).toBe("pt-BR")
		expect(resolveLocale("ID", SUPPORTED)).toBe("id")
	})

	it("prefers the exact tag over its primary subtag", () => {
		// Both pt-BR and pt-PT exist; a primary-subtag match would lose the region.
		expect(resolveLocale("pt-PT", SUPPORTED)).toBe("pt-PT")
		expect(resolveLocale("zh-TW", SUPPORTED)).toBe("zh-TW")
	})

	it("falls back to the primary subtag for an unlisted region", () => {
		// What a browser Accept-Language header sends.
		expect(resolveLocale("de-AT", SUPPORTED)).toBe("de")
		expect(resolveLocale("en_GB", SUPPORTED)).toBe("en")
	})

	it("rejects a language the dashboard does not ship", () => {
		expect(resolveLocale("sv", SUPPORTED)).toBeNull()
		expect(resolveLocale("tlh", SUPPORTED)).toBeNull()
	})

	it("rejects anything that is not a non-empty string", () => {
		for (const junk of [null, undefined, "", "   ", 0, 42, {}, [], true]) {
			expect(resolveLocale(junk, SUPPORTED), String(junk)).toBeNull()
		}
	})

	it("returns the caller's own spelling, not a normalised one", () => {
		// The cookie has to hold a tag the catalogue recognises; rewriting the
		// case here would break a list that uses mixed case by design.
		expect(resolveLocale("ZH-cn", SUPPORTED)).toBe("zh-CN")
	})
})
