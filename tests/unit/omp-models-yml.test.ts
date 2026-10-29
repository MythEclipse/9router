import { describe, expect, it } from "vitest"
import {
	ompHasThisInstall,
	ompProviderBlock,
	removeOmpProvider,
	withOmpProvider,
} from "../../apps/api/src/domain/omp-models-yml.ts"

/**
 * OMP's `models.yml` is edited by string surgery, so the property that matters most is
 * idempotence: saving twice must leave one provider block, not two.
 */

describe("ompProviderBlock", () => {
	it("carries the flags OMP needs to talk to this install", () => {
		const block = ompProviderBlock("http://x/v1", "sk-1")
		// Without authHeader OMP sends the key as a bearer token; without the strict-tools flag
		// it enforces tool schemas these models do not follow.
		expect(block).toContain("authHeader: true")
		expect(block).toContain("disableStrictTools: true")
		expect(block).toContain("baseUrl: http://x/v1")
		expect(block).toContain("apiKey: sk-1")
	})
})

describe("withOmpProvider", () => {
	it("creates the providers section for an empty file", () => {
		expect(withOmpProvider("", "http://x/v1", "sk-1")).toBe(
			`providers:\n${ompProviderBlock("http://x/v1", "sk-1")}\n`,
		)
	})

	it("is idempotent: saving twice leaves one block, not two", () => {
		// The bug this guards: without removing the stale block first, every save appends
		// another `9router:` key and the file stops being valid YAML.
		const once = withOmpProvider("", "http://x/v1", "sk-1")
		const twice = withOmpProvider(once, "http://y/v1", "sk-2")
		expect(twice.match(/^ {2}9router:/gm)).toHaveLength(1)
		expect(twice).toContain("http://y/v1")
		expect(twice).not.toContain("http://x/v1")
	})

	it("keeps other providers in the file", () => {
		const existing = "providers:\n  anthropic:\n    baseUrl: http://a\n"
		const written = withOmpProvider(existing, "http://x/v1", "sk-1")
		expect(written).toContain("anthropic:")
		expect(written).toContain("9router:")
	})

	it("appends a providers section when the file has other content but none", () => {
		const written = withOmpProvider("models:\n  - one\n", "http://x/v1", "sk-1")
		expect(written).toContain("models:")
		expect(written).toContain("providers:")
		expect(written).toContain("9router:")
	})

	it("removes a previously written block before adding the new one", () => {
		const once = withOmpProvider(
			"providers:\n  anthropic:\n    baseUrl: http://a\n",
			"http://x/v1",
			"sk",
		)
		const stripped = removeOmpProvider(once)
		expect(stripped).not.toContain("9router:")
		expect(stripped).toContain("anthropic:")
	})
})

describe("ompHasThisInstall", () => {
	it("recognises either the provider key or this install's host", () => {
		expect(ompHasThisInstall("")).toBe(false)
		expect(ompHasThisInstall(" 9router:\n")).toBe(true)
		expect(ompHasThisInstall("baseUrl: http://localhost:20128/v1")).toBe(true)
	})
})
