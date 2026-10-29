import { describe, expect, test } from "vitest"
import { providerLabel, providerOptions } from "../../apps/api/src/domain/provider-options"

const nodes = {
	"node-1": { name: "Team OpenAI", logo: "/logos/team.png" },
	"node-2": { name: "   ", logo: "/logos/blank.png" },
}
const catalog: Record<string, { name: string }> = {
	openai: { name: "OpenAI" },
	anthropic: { name: "Anthropic" },
}
const catalogOf = (id: string) => catalog[id] ?? null

describe("providerLabel", () => {
	test("a node name outranks the catalog", () => {
		// The operator's own naming must not be replaced by the catalog's.
		expect(providerLabel("node-1", nodes, catalogOf)).toEqual({
			name: "Team OpenAI",
			logo: "/logos/team.png",
		})
	})

	test("the catalog names a provider with no node", () => {
		expect(providerLabel("openai", nodes, catalogOf)).toEqual({ name: "OpenAI", logo: null })
	})

	test("a blank node name falls back rather than rendering a blank row", () => {
		expect(providerLabel("node-2", nodes, catalogOf)).toEqual({ name: "node-2", logo: null })
	})

	test("a provider no source knows keeps its id as the label", () => {
		// Dropping the row would hide traffic the operator is paying for.
		expect(providerLabel("mystery", nodes, catalogOf)).toEqual({ name: "mystery", logo: null })
	})

	test("a node without a logo reports null rather than an empty string", () => {
		expect(providerLabel("node-3", { "node-3": { name: "Local" } }, catalogOf).logo).toBe(null)
	})

	test("missing node and catalog lookups are tolerated", () => {
		expect(providerLabel("openai", null, catalogOf).name).toBe("OpenAI")
		expect(providerLabel("openai", undefined, () => undefined).name).toBe("openai")
	})

	test("an empty catalog name is not a name", () => {
		expect(providerLabel("blank", null, () => ({ name: "  " })).name).toBe("blank")
	})
})

describe("providerOptions", () => {
	test("carries the label under both keys the two filters read", () => {
		const [row] = providerOptions(["node-1"], nodes, catalogOf)
		expect(row.name).toBe("Team OpenAI")
		expect(row.nodeName).toBe("Team OpenAI")
		expect(row.logo).toBe("/logos/team.png")
		expect(row.nodeLogo).toBe("/logos/team.png")
		expect(row.id).toBe("node-1")
		expect(row.provider).toBe("node-1")
	})

	test("collapses a provider listed twice under the same id", () => {
		expect(providerOptions(["openai", "openai"], nodes, catalogOf)).toHaveLength(1)
	})

	test("keeps distinct providers in first-seen order", () => {
		const rows = providerOptions(["openai", "anthropic", "openai"], nodes, catalogOf)
		expect(rows.map((r) => r.id)).toEqual(["openai", "anthropic"])
	})

	test("drops non-strings and blanks, and trims padded ids", () => {
		const rows = providerOptions([42, null, "", "  ", " openai "], nodes, catalogOf)
		expect(rows.map((r) => r.id)).toEqual(["openai"])
	})

	test("an empty list yields no rows", () => {
		expect(providerOptions([], nodes, catalogOf)).toEqual([])
	})
})
