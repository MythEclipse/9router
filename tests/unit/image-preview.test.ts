import { describe, expect, it } from "vitest"
import {
	base64PngDataUrl,
	toImagePreviewSrc,
} from "@/app/(dashboard)/dashboard/media-providers/[kind]/[id]/components/imagePreview"

const B64 = "iVBORw0KGgoAAAANSUhEUg=="

describe("toImagePreviewSrc", () => {
	it("passes an https URL through untouched", () => {
		expect(toImagePreviewSrc("https://cdn.example/a.png")).toBe("https://cdn.example/a.png")
	})

	it("passes an http URL through untouched", () => {
		expect(toImagePreviewSrc("http://localhost:20128/img.png")).toBe("http://localhost:20128/img.png")
	})

	it("passes an existing data URL through untouched", () => {
		const src = "data:image/jpeg;base64,/9j/4AAQ"
		expect(toImagePreviewSrc(src)).toBe(src)
	})

	it("passes a blob URL through untouched", () => {
		expect(toImagePreviewSrc("blob:http://localhost/abc")).toBe("blob:http://localhost/abc")
	})

	it("prefixes bare base64 as PNG", () => {
		expect(toImagePreviewSrc(B64)).toBe(`data:image/png;base64,${B64}`)
	})

	it("trims surrounding whitespace before deciding", () => {
		expect(toImagePreviewSrc(`  ${B64}\n`)).toBe(`data:image/png;base64,${B64}`)
		expect(toImagePreviewSrc("  https://x/a.png  ")).toBe("https://x/a.png")
	})

	it("returns empty string for blank, null and non-string input", () => {
		// An empty src makes the browser re-request the page, so callers rely on "".
		expect(toImagePreviewSrc("")).toBe("")
		expect(toImagePreviewSrc("   ")).toBe("")
		expect(toImagePreviewSrc(null)).toBe("")
		expect(toImagePreviewSrc(undefined)).toBe("")
		expect(toImagePreviewSrc(42)).toBe("")
		expect(toImagePreviewSrc({})).toBe("")
	})

	it("treats a case-insensitive scheme as already a URL", () => {
		expect(toImagePreviewSrc("HTTPS://x/a.png")).toBe("HTTPS://x/a.png")
		expect(toImagePreviewSrc("DATA:image/png;base64,abc")).toBe("DATA:image/png;base64,abc")
	})

	it("still prefixes base64 that merely contains the word data", () => {
		// The test is anchored, so a payload is not mistaken for a scheme.
		expect(toImagePreviewSrc("metadata:abc")).toBe("data:image/png;base64,metadata:abc")
	})

	it("matches the expression it replaced", () => {
		const legacy = (value: unknown) => {
			const trimmed = typeof value === "string" ? value.trim() : ""
			if (!trimmed) return ""
			if (/^(data:image\/|https?:\/\/)/i.test(trimmed)) return trimmed
			return `data:image/png;base64,${trimmed}`
		}
		const inputs = [
			"",
			"   ",
			B64,
			"https://x/a.png",
			"http://x/a.png",
			"data:image/png;base64," + B64,
			"data:image/jpeg;base64,x",
			null,
			undefined,
			0,
			{},
			"metadata:abc",
		]
		for (const v of inputs) {
			// The one intended difference: blob: and other data: subtypes already render.
			const expected = legacy(v)
			const actual = toImagePreviewSrc(v)
			if (typeof v === "string" && /^(blob:|data:(?!image\/))/i.test(v)) {
				expect(actual).toBe(v.trim())
			} else {
				expect(actual).toBe(expected)
			}
		}
	})
})

describe("base64PngDataUrl", () => {
	it("builds a PNG data URL from bare bytes", () => {
		expect(base64PngDataUrl(B64)).toBe(`data:image/png;base64,${B64}`)
	})

	it("trims whitespace from the payload", () => {
		expect(base64PngDataUrl(` ${B64} `)).toBe(`data:image/png;base64,${B64}`)
	})

	it("returns empty string for a missing payload", () => {
		expect(base64PngDataUrl(undefined)).toBe("")
		expect(base64PngDataUrl(null)).toBe("")
		expect(base64PngDataUrl("")).toBe("")
		expect(base64PngDataUrl("   ")).toBe("")
	})

	it("composes with || so a b64 result wins over a url", () => {
		// This is how the call sites read: b64 first, url as the fallback.
		const first = { b64_json: B64, url: "https://x/a.png" }
		expect(base64PngDataUrl(first.b64_json) || first.url || "").toBe(`data:image/png;base64,${B64}`)
	})

	it("falls back to the url when there is no b64", () => {
		const first: { b64_json?: string; url?: string } = { url: "https://x/a.png" }
		expect(base64PngDataUrl(first.b64_json) || first.url || "").toBe("https://x/a.png")
	})

	it("falls back to empty when there is neither", () => {
		const first: { b64_json?: string; url?: string } = {}
		expect(base64PngDataUrl(first.b64_json) || first.url || "").toBe("")
	})

	it("matches the expression it replaced", () => {
		const legacy = (b64: unknown) => (b64 ? `data:image/png;base64,${b64}` : "")
		for (const v of [B64, "", null, undefined]) {
			expect(base64PngDataUrl(v)).toBe(legacy(v))
		}
	})
})
