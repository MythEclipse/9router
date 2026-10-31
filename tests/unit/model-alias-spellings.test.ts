import { matchesAnyModelName, parseAllowedModels } from "@9router/db/repos/allowedModels"
import { describe, expect, it } from "vitest"
import { modelIdSpellings, resolveProviderAlias } from "../../apps/web/open-sse/services/model.js"

// A model answers to several ids: the operator's alias, the canonical provider id,
// and any legacy alias kept for old clients. An allow-list stores whichever spelling
// the operator saw when the key was created, so the gate has to judge them as one
// model. Comparing a single spelling is what turned `oc/big-pickle` into a 403 once
// the registry alias moved to `oc1`.
describe("model id spellings", () => {
	it("resolves every alias of the opencode lane to its provider id", () => {
		expect(resolveProviderAlias("oc")).toBe("opencode")
		expect(resolveProviderAlias("oc1")).toBe("opencode")
		expect(resolveProviderAlias("opencode")).toBe("opencode")
	})

	it("lists the alias, the canonical id and the legacy alias for one model", () => {
		const spellings = modelIdSpellings("oc1/big-pickle")
		expect(spellings).toContain("oc1/big-pickle")
		expect(spellings).toContain("oc/big-pickle")
		expect(spellings).toContain("opencode/big-pickle")
	})

	it("leaves a bare model name and an unknown provider untouched", () => {
		expect(modelIdSpellings("big-pickle")).toEqual(["big-pickle"])
		expect(modelIdSpellings("not-a-provider/some-model")).toEqual(["not-a-provider/some-model"])
	})

	it("does not invent spellings for a provider with no other names", () => {
		expect(modelIdSpellings("openai/gpt-4")).toEqual(["openai/gpt-4"])
	})
})

describe("allow-list admission across spellings", () => {
	const admits = (scope: string, requested: string) =>
		matchesAnyModelName(parseAllowedModels(scope), modelIdSpellings(requested))

	// The reported failure, inverted: the key was scoped with one spelling and the
	// client sent another, so a model the operator allowed came back as 403.
	it("admits a model whose scope names a different spelling", () => {
		expect(admits("oc/big-pickle", "oc1/big-pickle")).toBe(true)
		expect(admits("opencode/big-pickle", "oc/big-pickle")).toBe(true)
		expect(admits("oc1/big-pickle", "oc/big-pickle")).toBe(true)
		expect(admits("oc/*", "opencode/big-pickle")).toBe(true)
		expect(admits("opencode/*", "oc1/big-pickle")).toBe(true)
	})

	it("still refuses a model the scope never named", () => {
		expect(admits("oc/big-pickle", "ps/laguna-s-2.1")).toBe(false)
		expect(admits("oc/*", "ps/laguna-s-2.1")).toBe(false)
		expect(admits("openai/*", "oc/big-pickle")).toBe(false)
	})

	it("admits everything when the key carries no scope", () => {
		expect(admits("*", "oc/big-pickle")).toBe(true)
		expect(matchesAnyModelName(null, modelIdSpellings("oc/big-pickle"))).toBe(true)
	})
})
