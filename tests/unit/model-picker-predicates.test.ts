import { matchesAllowedModels, parseAllowedModels } from "@9router/db/repos/allowedModels"
import { describe, expect, it } from "vitest"
import { isOrphanCompatAlias, matchesModelScope } from "@/shared/utils/modelPickerPredicates"

/**
 * The picker must admit exactly what the request gate admits. If it is looser, a
 * scoped session is offered models it is then refused for; if stricter, it hides
 * models the session may legitimately use. Both are silent failures, so the
 * agreement is asserted directly rather than assumed from shared code.
 */
describe("matchesModelScope agrees with the server gate", () => {
	const scopes = [
		null,
		"",
		"*",
		"gpt-5",
		"openai/gpt-5",
		"gpt-*,claude-*",
		"*mini",
		"GPT-5",
		" gpt-5 , claude-sonnet-4-5 ",
		"unknown-model",
	]
	const models = [
		"gpt-5",
		"gpt-5-mini",
		"claude-sonnet-4-5",
		"openai/gpt-5",
		"anthropic/claude-sonnet-4-5",
		"",
		"GPT-5",
	]

	it("admits a model exactly when the gate does", () => {
		for (const scope of scopes) {
			const patterns = parseAllowedModels(scope)
			for (const model of models) {
				expect(matchesModelScope(patterns, model)).toBe(matchesAllowedModels(patterns, model))
			}
		}
	})
})

describe("matchesModelScope", () => {
	it("treats an empty or missing scope as unrestricted", () => {
		expect(matchesModelScope(null, "anything")).toBe(true)
		expect(matchesModelScope([], "anything")).toBe(true)
		expect(matchesModelScope(undefined, "anything")).toBe(true)
	})

	it("matches an exact name case-insensitively when patterns are parsed", () => {
		// Patterns arrive normalized by parseAllowedModels; the match itself is case-
		// insensitive on the model side, so a caller's mixed-case name still hits.
		expect(matchesModelScope(parseAllowedModels("GPT-5"), "gpt-5")).toBe(true)
		expect(matchesModelScope(parseAllowedModels("gpt-5"), "GPT-5")).toBe(true)
		expect(matchesModelScope(parseAllowedModels("gpt-5"), "gpt-5")).toBe(true)
	})

	it("expects already-normalized patterns, as parseAllowedModels produces", () => {
		// An unparsed, upper-case pattern does not match: normalization is the parser's
		// job, and duplicating it here is what let the copy drift before.
		expect(matchesModelScope(["GPT-5"], "gpt-5")).toBe(false)
	})

	it("matches a prefix pattern", () => {
		expect(matchesModelScope(["gpt-*"], "gpt-5-mini")).toBe(true)
		expect(matchesModelScope(["gpt-*"], "claude-3")).toBe(false)
	})

	it("matches a suffix pattern", () => {
		expect(matchesModelScope(["*mini"], "gpt-5-mini")).toBe(true)
		expect(matchesModelScope(["*mini"], "gpt-5")).toBe(false)
	})

	it("matches the wildcard alone", () => {
		expect(matchesModelScope(["*"], "anything")).toBe(true)
	})

	it("accepts a hit on any of the candidate names", () => {
		// A caller may hold the id, the display value, or a routed name; a scope naming
		// any one of them is satisfied.
		expect(matchesModelScope(["openai/gpt-5"], "Some Label", "openai/gpt-5")).toBe(true)
		expect(matchesModelScope(["gpt-5"], "gpt-5", "some-id")).toBe(true)
	})

	it("rejects a model outside the scope", () => {
		expect(matchesModelScope(["gpt-5"], "claude-3")).toBe(false)
	})

	it("rejects when every candidate is empty", () => {
		expect(matchesModelScope(["gpt-5"], "", null, undefined)).toBe(false)
	})

	it("ignores empty candidates but still matches a real one", () => {
		expect(matchesModelScope(["gpt-5"], "", null, "gpt-5")).toBe(true)
	})

	it("trims surrounding whitespace in candidates", () => {
		expect(matchesModelScope(["gpt-5"], "  gpt-5  ")).toBe(true)
	})
})

describe("isOrphanCompatAlias", () => {
	// Mirrors the real humanizeCompatId: a generated compat id humanizes to a label,
	// a plain provider name humanizes to "".
	const humanize = (id: string) =>
		id.startsWith("compat-") ? `OpenAI Compatible (${id.slice(7)})` : ""

	it("is false for a non-generated alias", () => {
		expect(isOrphanCompatAlias("openai", [], humanize)).toBe(false)
		expect(isOrphanCompatAlias("my-custom-node", [], humanize)).toBe(false)
	})

	it("is false for a missing or non-string alias", () => {
		expect(isOrphanCompatAlias("", [], humanize)).toBe(false)
		expect(isOrphanCompatAlias(null, [], humanize)).toBe(false)
		expect(isOrphanCompatAlias(undefined, [], humanize)).toBe(false)
		expect(isOrphanCompatAlias(42, [], humanize)).toBe(false)
	})

	it("is true for a generated alias no live node claims", () => {
		expect(isOrphanCompatAlias("compat-abc", [], humanize)).toBe(true)
		expect(isOrphanCompatAlias("compat-abc", [{ id: "other" }], humanize)).toBe(true)
		expect(isOrphanCompatAlias("compat-abc", null, humanize)).toBe(true)
	})

	it("is false when a live node still claims the alias", () => {
		expect(isOrphanCompatAlias("compat-abc", [{ id: "compat-abc" }], humanize)).toBe(false)
	})

	it("tolerates null entries in the node list", () => {
		expect(isOrphanCompatAlias("compat-abc", [null, { id: "compat-abc" }], humanize)).toBe(false)
	})
})
