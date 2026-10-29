import { describe, expect, test } from "vitest"
import { aliasWriteRefusal, sanitizeAliasMappings } from "../../apps/api/src/domain/mitm-alias"

const DNS_ON = { claude: true, codex: false }

describe("aliasWriteRefusal", () => {
	test("a tool whose DNS is enabled may be edited", () => {
		expect(aliasWriteRefusal("claude", { a: "b" }, DNS_ON)).toBe(null)
	})

	test("a tool whose DNS is off is refused with 403, because the alias would never fire", () => {
		// Storing it would report "saved" for a mapping the proxy never sees.
		expect(aliasWriteRefusal("codex", { a: "b" }, DNS_ON)).toEqual({
			status: 403,
			error: "DNS must be enabled for codex before editing model mappings",
		})
	})

	test("a tool absent from the map is not enabled", () => {
		expect(aliasWriteRefusal("unknown", { a: "b" }, DNS_ON)?.status).toBe(403)
	})

	test("a missing DNS map refuses rather than assuming enabled", () => {
		expect(aliasWriteRefusal("claude", { a: "b" }, null)?.status).toBe(403)
		expect(aliasWriteRefusal("claude", { a: "b" }, undefined)?.status).toBe(403)
	})

	test("a malformed body is a 400 before DNS is consulted", () => {
		expect(aliasWriteRefusal("", { a: "b" }, DNS_ON)?.status).toBe(400)
		expect(aliasWriteRefusal(undefined, { a: "b" }, DNS_ON)?.status).toBe(400)
		expect(aliasWriteRefusal("claude", null, DNS_ON)?.status).toBe(400)
		expect(aliasWriteRefusal("claude", "mappings", DNS_ON)?.status).toBe(400)
	})

	test("the 400 message names both required fields", () => {
		expect(aliasWriteRefusal(undefined, undefined, DNS_ON)?.error).toBe("tool and mappings required")
	})
})

describe("sanitizeAliasMappings", () => {
	test("model names are trimmed", () => {
		expect(sanitizeAliasMappings({ "gpt-5": "  claude-sonnet-4  " })).toEqual({
			"gpt-5": "claude-sonnet-4",
		})
	})

	test("the editor's empty row does not become an alias to nothing", () => {
		// The form always sends one blank row; storing it would rewrite the model to "".
		expect(sanitizeAliasMappings({ "gpt-5": "claude", "": "" })).toEqual({
			"gpt-5": "claude",
		})
		expect(sanitizeAliasMappings({ "gpt-5": "   " })).toEqual({})
	})

	test("non-string targets are dropped rather than stringified", () => {
		expect(sanitizeAliasMappings({ a: 42, b: null, c: undefined, d: "ok" })).toEqual({ d: "ok" })
	})

	test("a non-object input yields an empty map, not a throw", () => {
		expect(sanitizeAliasMappings(null)).toEqual({})
		expect(sanitizeAliasMappings("x")).toEqual({})
	})

	test("the alias key itself is kept verbatim, including surrounding spaces", () => {
		// The alias is what the tool sends; trimming it would silently stop matching.
		expect(sanitizeAliasMappings({ " gpt-5 ": "claude" })).toEqual({ " gpt-5 ": "claude" })
	})
})
