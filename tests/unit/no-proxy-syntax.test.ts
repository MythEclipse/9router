// NO_PROXY / noProxy parsing decides whether a request is allowed to leave
// directly or must go through the configured proxy. Two standard syntaxes were
// silently ignored, so an explicitly excluded host still egressed through the
// proxy:
//
//   • `*.example.com` — the most common suffix notation, parsed as a literal
//     host name containing `*`, so it never matched.
//   • `host:port` — parsed as a host name containing `:port`, so it never
//     matched either.
import { describe, expect, it } from "vitest"

const { shouldBypassByNoProxy } = await import("../../open-sse/utils/proxyFetch.js")

const HTTPS_URL = "https://api.example.com/v1/chat"
const HTTP_URL = "http://api.example.com/v1/chat"

describe("noProxy syntax", () => {
	it("matches a bare host and its subdomains", () => {
		expect(shouldBypassByNoProxy(HTTPS_URL, "example.com")).toBe(true)
		expect(shouldBypassByNoProxy(HTTPS_URL, "api.example.com")).toBe(true)
	})

	it("honours the leading-dot suffix notation", () => {
		expect(shouldBypassByNoProxy(HTTPS_URL, ".example.com")).toBe(true)
	})

	it("honours the *.domain suffix notation", () => {
		expect(shouldBypassByNoProxy(HTTPS_URL, "*.example.com")).toBe(true)
	})

	it("honours host:port when the port matches the effective port", () => {
		expect(shouldBypassByNoProxy(HTTPS_URL, "api.example.com:443")).toBe(true)
		expect(shouldBypassByNoProxy(HTTP_URL, "api.example.com:80")).toBe(true)
		expect(shouldBypassByNoProxy("https://api.example.com:8443/v1", "api.example.com:8443")).toBe(
			true,
		)
	})

	it("does not bypass when host:port carries a different port", () => {
		expect(shouldBypassByNoProxy(HTTPS_URL, "api.example.com:8080")).toBe(false)
	})

	it("does not bypass an unrelated host", () => {
		expect(shouldBypassByNoProxy("https://api.other.com/v1", "*.example.com")).toBe(false)
	})

	it("treats a wildcard entry as bypass-everything", () => {
		expect(shouldBypassByNoProxy("https://anything.test/v1", "*")).toBe(true)
	})

	it("handles a comma-separated list and stray whitespace", () => {
		expect(shouldBypassByNoProxy(HTTPS_URL, " localhost , *.example.com , 127.0.0.1 ")).toBe(true)
	})

	it("returns false for empty or unparseable input", () => {
		expect(shouldBypassByNoProxy(HTTPS_URL, "")).toBe(false)
		expect(shouldBypassByNoProxy(HTTPS_URL, null)).toBe(false)
		expect(shouldBypassByNoProxy("not a url", "example.com")).toBe(false)
	})
})
