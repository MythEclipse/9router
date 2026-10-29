import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { aggregateComboCapabilities } from "../../apps/web/open-sse/providers/capabilities"

/**
 * Sources are formatted without semicolons, so literals ending in ";"
 * never matched. Normalise both sides before comparing.
 */
const withoutSemicolons = (text: string) => text.replace(/;\s*$/gm, "").replace(/;\n/g, "\n")

describe("aggregateComboCapabilities - null / empty", () => {
	it("returns null for null", () => {
		expect(aggregateComboCapabilities(null)).toBeNull()
	})

	it("returns null for empty array", () => {
		expect(aggregateComboCapabilities([])).toBeNull()
	})
})

describe("aggregateComboCapabilities - single model passthrough", () => {
	it("single model returns its own capabilities", () => {
		const caps = aggregateComboCapabilities(["opencode-go/mimo-v2.5"])
		expect(caps.vision).toBe(true)
		expect(caps.reasoning).toBe(true)
		expect(caps.thinkingFormat).toBe("deepseek")
		expect(caps.thinkingCanDisable).toBe(false)
		expect(caps.contextWindow).toBe(1048576)
		expect(caps.maxOutput).toBe(131072)
	})
})

describe("aggregateComboCapabilities - union fields (vision, audioInput, search)", () => {
	it("vision is true if any backend has it", () => {
		// deepseek-v4-pro: no vision; mimo-v2.5: vision
		const caps = aggregateComboCapabilities(["opencode-go/deepseek-v4-pro", "opencode-go/mimo-v2.5"])
		expect(caps.vision).toBe(true)
	})

	it("vision is false if no backend has it", () => {
		const caps = aggregateComboCapabilities([
			"opencode-go/deepseek-v4-pro",
			"opencode-go/deepseek-v4-flash",
		])
		expect(caps.vision).toBe(false)
	})

	it("audioInput is true if any backend has it", () => {
		// mimo-omni has audioInput; mimo-v2.5 does not
		const caps = aggregateComboCapabilities(["opencode-go/mimo-v2.5", "opencode-go/mimo-omni-test"])
		expect(caps.audioInput).toBe(true)
	})

	it("search is true if any backend has it", () => {
		// gpt-5: search; mimo-v2.5: no search
		const caps = aggregateComboCapabilities(["openai/gpt-5", "opencode-go/mimo-v2.5"])
		expect(caps.search).toBe(true)
	})
})

describe("aggregateComboCapabilities - intersection: tools", () => {
	it("tools is false if any backend lacks it", () => {
		// gpt-image-1: tools:false; gpt-5: tools:true
		const caps = aggregateComboCapabilities(["openai/gpt-5", "openai/gpt-image-1"])
		expect(caps.tools).toBe(false)
	})

	it("tools is true when all backends support it", () => {
		const caps = aggregateComboCapabilities(["opencode-go/mimo-v2.5", "opencode-go/kimi-k2.5"])
		expect(caps.tools).toBe(true)
	})
})

describe("aggregateComboCapabilities - primary model drives reasoning fields", () => {
	it("thinkingFormat comes from the first model", () => {
		// primary: mimo-v2.5 (deepseek); secondary: kimi-k2.5 (kimi)
		const caps = aggregateComboCapabilities(["opencode-go/mimo-v2.5", "opencode-go/kimi-k2.5"])
		expect(caps.thinkingFormat).toBe("deepseek")
		expect(caps.reasoning).toBe(true)
	})

	it("flipping order changes thinkingFormat to the new primary", () => {
		const caps = aggregateComboCapabilities(["opencode-go/kimi-k2.5", "opencode-go/mimo-v2.5"])
		expect(caps.thinkingFormat).toBe("kimi")
	})
})

describe("aggregateComboCapabilities - context/output limits", () => {
	it("contextWindow is the largest window across all models", () => {
		// mimo-v2.5: 1048576; kimi-k2.5 (*kimi*k2* pattern): 262144.
		// A combo fails over between models, so it can use the biggest window its
		// members offer; taking the smallest would compact a 1M model at 256k.
		const caps = aggregateComboCapabilities(["opencode-go/mimo-v2.5", "opencode-go/kimi-k2.5"])
		expect(caps.contextWindow).toBe(1048576)
	})

	it("maxOutput is the largest across all models", () => {
		// A combo can use the largest output limit offered by any fallback member.
		const caps = aggregateComboCapabilities(["opencode-go/mimo-v2.5", "opencode-go/kimi-k2.5"])
		expect(caps.maxOutput).toBe(262144)
	})

	it("an explicit context window on the combo wins over the auto value", () => {
		// (models, lookup, resolveCaps, depth, contextOverride) — the window lives in the
		// last slot; it used to sit third, until the resolver was inserted before it.
		const caps = aggregateComboCapabilities(
			["opencode-go/mimo-v2.5", "opencode-go/kimi-k2.5"],
			null,
			null,
			0,
			2000000,
		)
		expect(caps.contextWindow).toBe(2000000)
	})
})

describe("aggregateComboCapabilities - nested combo resolution via comboLookup", () => {
	it("resolves nested combo and unions vision from its members", () => {
		const lookup = { "inner-combo": ["opencode-go/deepseek-v4-pro", "opencode-go/mimo-v2.5"] }
		const caps = aggregateComboCapabilities(["inner-combo"], lookup)
		expect(caps.reasoning).toBe(true)
		expect(caps.vision).toBe(true) // mimo brings vision through the lookup
	})

	it("outer combo gets vision via nested combo containing mimo", () => {
		const lookup = {
			"deepseek-v4-pro-fusion": ["opencode-go/deepseek-v4-pro", "opencode-go/mimo-v2.5"],
		}
		const caps = aggregateComboCapabilities(["deepseek-v4-pro-fusion", "openai/gpt-5"], lookup)
		expect(caps.vision).toBe(true)
		expect(caps.reasoning).toBe(true)
	})

	it("contextWindow is the largest window across all resolved leaves", () => {
		// deepseek-v4-pro (*deepseek-v4*): 1000000; mimo-v2.5: 1048576 → max = 1048576
		const lookup = { inner: ["opencode-go/deepseek-v4-pro"] }
		const caps = aggregateComboCapabilities(["inner", "opencode-go/mimo-v2.5"], lookup)
		expect(caps.contextWindow).toBe(1048576)
	})

	it("a custom window reaches nested combos too", () => {
		const lookup = { inner: ["opencode-go/deepseek-v4-pro"] }
		const caps = aggregateComboCapabilities(
			["inner", "opencode-go/mimo-v2.5"],
			lookup,
			null,
			0,
			2000000,
		)
		expect(caps.contextWindow).toBe(2000000)
	})

	it("handles cycles without throwing", () => {
		const lookup = { a: ["b"], b: ["a"] }
		expect(() => aggregateComboCapabilities(["a"], lookup)).not.toThrow()
	})

	it("without comboLookup bare combo name falls through to pattern match", () => {
		// *deepseek-v4* pattern: reasoning true, vision false
		const caps = aggregateComboCapabilities(["deepseek-v4-pro-fusion"])
		expect(caps.reasoning).toBe(true)
		expect(caps.vision).toBe(false)
	})
})

describe("aggregateComboCapabilities - the resolver slot cannot break the list", () => {
	it("ignores a non-function resolver instead of throwing", () => {
		// The server routes used to pass the recursion depth here. `0?.(id)` is a TypeError,
		// so /api/models answered "Error fetching models: e is not a function" for anyone
		// who had a combo defined.
		expect(() => aggregateComboCapabilities(["openai/gpt-5"], null, 0)).not.toThrow()
		expect(aggregateComboCapabilities(["openai/gpt-5"], null, 0)).toBeTruthy()
	})

	it("still honours a context override passed alongside a bad resolver", () => {
		const caps = aggregateComboCapabilities(["openai/gpt-5"], null, 0, 0, 500000)
		expect(caps.contextWindow).toBe(500000)
	})

	it("merges a resolver's limits over the local tables and keeps the rest", () => {
		const caps = aggregateComboCapabilities(["openai/gpt-5"], null, () => ({ contextWindow: 128000 }))
		expect(caps.contextWindow).toBe(128000)
		expect(caps).toHaveProperty("tools")
	})
})

describe("the routes that publish combos pass the arguments in the right slots", () => {
	// The dashboard's call used to sit in the route; it moved into the catalogue
	// adapter when the model list became a use-case. The invariant is unchanged —
	// one aggregator, with the resolver null and the window last — so the check
	// follows the call rather than pinning it to a file name.
	for (const file of [
		"apps/web/src/lib/modelRegistryHost.ts",
		"apps/web/src/app/api/v1/models/route.ts",
	]) {
		it(`${file} sends null for the resolver and the combo window last`, () => {
			const src = withoutSemicolons(readFileSync(resolve(__dirname, "../..", file), "utf8"))
			// The call is spread over several lines, so the pattern tolerates
			// whitespace between arguments instead of demanding a single line.
			expect(src).toMatch(
				/aggregateComboCapabilities\(\s*[\w.]+,\s*(?:comboByName|byName),\s*null,\s*0,\s*(?:Number\(combo\.contextWindow\)\s*\|\|\s*0|contextWindow),?\s*\)/,
			)
			expect(src).not.toMatch(/aggregateComboCapabilities\([^)]*(?:comboByName|byName), 0,/)
		})
	}

	it("the use-case asks the port instead of re-implementing the aggregation", () => {
		const src = readFileSync(
			resolve(__dirname, "../..", "apps/api/src/application/models/list-models.ts"),
			"utf8",
		)
		expect(src).toMatch(/deps\.catalogue\.aggregateCombo\(/)
	})
})
