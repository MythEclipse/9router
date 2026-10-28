import { describe, expect, it } from "vitest"
import { normalizeConfigString } from "@/lib/network/normalizeConfigString"

/**
 * Four copies of this lived in the proxy stack. The null/undefined rule is the one
 * that matters: without it an unset proxy host stringifies to "null" and looks
 * configured, so a request is routed at a host literally named null.
 */
describe("normalizeConfigString", () => {
	it("maps null and undefined to an empty string, not the word", () => {
		expect(normalizeConfigString(null)).toBe("")
		expect(normalizeConfigString(undefined)).toBe("")
	})

	it("trims surrounding whitespace", () => {
		expect(normalizeConfigString("  http://proxy:8080  ")).toBe("http://proxy:8080")
		expect(normalizeConfigString("\t\n value \n")).toBe("value")
	})

	it("stringifies numbers, so a stored port survives", () => {
		expect(normalizeConfigString(8080)).toBe("8080")
		expect(normalizeConfigString(0)).toBe("0")
	})

	it("stringifies booleans", () => {
		expect(normalizeConfigString(false)).toBe("false")
	})

	it("leaves an ordinary string alone", () => {
		expect(normalizeConfigString("direct")).toBe("direct")
	})

	it("collapses a whitespace-only value to empty", () => {
		expect(normalizeConfigString("   ")).toBe("")
	})

	it("matches the expression it replaced, across every type", () => {
		const legacy = (value: unknown) => {
			if (value === undefined || value === null) return ""
			return String(value).trim()
		}
		const values: unknown[] = [null, undefined, "", " ", "a", " a ", 0, 1, 8080, false, true, NaN]
		for (const v of values) {
			expect(normalizeConfigString(v)).toBe(legacy(v))
		}
	})
})
