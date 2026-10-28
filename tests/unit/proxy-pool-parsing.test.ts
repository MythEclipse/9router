import { describe, expect, it } from "vitest"
import {
	formatDateTime,
	getStatusVariant,
	normalizeFormData,
	parseProxyImport,
	parseProxyLine,
	splitImportLines,
} from "@/app/(dashboard)/dashboard/proxy-pools/proxyPoolParsing"

describe("parseProxyLine", () => {
	it("keeps the credentials in the URL but names it by host and port", () => {
		const parsed = parseProxyLine("http://user:pass@host.example:8080")
		expect(parsed?.proxyUrl).toBe("http://user:pass@host.example:8080/")
		expect(parsed?.name).toBe("Imported host.example:8080")
	})

	it("names a URL without a port by hostname alone", () => {
		// hostLabel uses hostname, and the URL normalizes the trailing slash.
		const parsed = parseProxyLine("http://host.example")
		expect(parsed?.name).toBe("Imported host.example")
	})

	it("accepts a socks URL", () => {
		expect(parseProxyLine("socks5://host.example:1080")?.proxyUrl).toContain("socks5://")
	})

	it("builds a URL from host:port:user:pass", () => {
		const parsed = parseProxyLine("1.2.3.4:8080:alice:s3cret")
		expect(parsed?.proxyUrl).toBe("http://alice:s3cret@1.2.3.4:8080/")
		expect(parsed?.name).toBe("Imported 1.2.3.4:8080")
	})

	it("rejects a colon in the password, since it breaks the four-part split", () => {
		// The format cannot carry a colon in either credential; documented here so the
		// limitation is a decision rather than a surprise.
		expect(() => parseProxyLine("1.2.3.4:8080:ali ce:p@ss:word")).toThrow("Unsupported format")
	})

	it("percent-encodes characters that are legal in the field but not in a URL", () => {
		const parsed = parseProxyLine("1.2.3.4:8080:user:p@ss%word")
		expect(parsed?.proxyUrl).toContain("p%40ss%25word")
	})

	it("returns null for a blank line", () => {
		expect(parseProxyLine("")).toBeNull()
		expect(parseProxyLine("   ")).toBeNull()
	})

	it("rejects an empty field in the four-part form", () => {
		expect(() => parseProxyLine("1.2.3.4::alice:s3cret")).toThrow(
			"Invalid host:port:user:pass format",
		)
		expect(() => parseProxyLine("1.2.3.4:8080::s3cret")).toThrow("Invalid host:port:user:pass format")
	})

	it("rejects an unsupported shape", () => {
		expect(() => parseProxyLine("host.example")).toThrow("Unsupported format")
		expect(() => parseProxyLine("1.2.3.4:8080")).toThrow("Unsupported format")
		expect(() => parseProxyLine("a:b:c:d:e")).toThrow("Unsupported format")
	})
})

describe("splitImportLines", () => {
	it("splits on either newline style and trims", () => {
		expect(splitImportLines("  a \r\n b\n\nc  ")).toEqual(["a", "b", "c"])
	})

	it("returns nothing for blank input", () => {
		expect(splitImportLines("")).toEqual([])
		expect(splitImportLines("\n\n  \n")).toEqual([])
	})
})

describe("parseProxyImport", () => {
	it("numbers entries by their position in the pasted text", () => {
		// A blank line in the middle must not shift the reported numbers: the operator
		// reads them against what they pasted.
		const { entries, errors } = parseProxyImport("http://a.example:1\n\n1.2.3.4:8080:u:p\n")
		expect(errors).toEqual([])
		expect(entries.map((e: { lineNumber: number }) => e.lineNumber)).toEqual([1, 3])
	})

	it("reports a bad line against the real line number even after blanks", () => {
		const { errors } = parseProxyImport("\n\nnope\n")
		expect(errors).toEqual(["Line 3: Unsupported format"])
	})

	it("reports every bad line, not just the first", () => {
		const { entries, errors } = parseProxyImport("nope\nhttp://ok.example:1\nalso-bad")
		expect(entries).toHaveLength(1)
		expect(errors).toHaveLength(2)
		expect(errors[0]).toBe("Line 1: Unsupported format")
		expect(errors[1]).toBe("Line 3: Unsupported format")
	})

	it("returns nothing for an empty paste", () => {
		expect(parseProxyImport("   \n\n")).toEqual({ entries: [], errors: [] })
	})
})

describe("getStatusVariant", () => {
	it("maps the known statuses", () => {
		expect(getStatusVariant("active")).toBe("success")
		expect(getStatusVariant("error")).toBe("error")
	})

	it("defaults everything else", () => {
		expect(getStatusVariant("unknown")).toBe("default")
		expect(getStatusVariant(null)).toBe("default")
		expect(getStatusVariant(undefined)).toBe("default")
	})
})

describe("formatDateTime", () => {
	it("renders a date", () => {
		expect(formatDateTime("2026-03-15T10:30:00.000Z")).not.toBe("Never")
	})

	it("returns Never for a missing or unparseable value", () => {
		expect(formatDateTime(null)).toBe("Never")
		expect(formatDateTime(undefined)).toBe("Never")
		expect(formatDateTime("")).toBe("Never")
		expect(formatDateTime("not-a-date")).toBe("Never")
	})
})

describe("normalizeFormData", () => {
	it("fills blanks for a new pool", () => {
		expect(normalizeFormData()).toEqual({
			name: "",
			proxyUrl: "",
			noProxy: "",
			isActive: true,
			strictProxy: false,
		})
	})

	it("defaults isActive to true and strictProxy to false, in opposite directions", () => {
		const form = normalizeFormData({ name: "p" })
		expect(form.isActive).toBe(true)
		expect(form.strictProxy).toBe(false)
	})

	it("respects explicit false and true", () => {
		expect(normalizeFormData({ isActive: false }).isActive).toBe(false)
		expect(normalizeFormData({ strictProxy: true }).strictProxy).toBe(true)
	})

	it("treats a null isActive as active", () => {
		expect(normalizeFormData({ isActive: null as any }).isActive).toBe(true)
	})

	it("carries the stored values through", () => {
		expect(
			normalizeFormData({
				name: "n",
				proxyUrl: "u",
				noProxy: "x",
				isActive: false,
				strictProxy: true,
			}),
		).toEqual({ name: "n", proxyUrl: "u", noProxy: "x", isActive: false, strictProxy: true })
	})
})
