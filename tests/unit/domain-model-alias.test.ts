import { describe, expect, it } from "vitest"
import {
	makeCustomModels,
	makeModelAliases,
} from "../../apps/api/src/application/models/manage-aliases.ts"
import {
	isCustomModelRefusal,
	readCustomModel,
	sanitizeCaps,
	sanitizeTransport,
} from "../../apps/api/src/domain/custom-model.ts"
import {
	reconcileForAliasRepoint,
	validateAliasInput,
} from "../../apps/api/src/domain/model-alias.ts"

describe("validateAliasInput", () => {
	it("requires both fields", () => {
		expect(validateAliasInput({ model: "", alias: "a" })?.message).toBe("Model and alias required")
		expect(validateAliasInput({ model: "m", alias: "  " })?.message).toBe("Model and alias required")
		expect(validateAliasInput({ model: 1, alias: "a" })?.message).toBe("Model and alias required")
	})

	it("accepts a complete pair", () => {
		expect(validateAliasInput({ model: "openai/gpt-4o", alias: "fast" })).toBeNull()
	})
})

describe("reconcileForAliasRepoint", () => {
	it("follows the alias when it now points somewhere else", () => {
		// The alias *name* does not move; the model it resolves to does. A key that
		// pinned the old target has to follow it.
		expect(reconcileForAliasRepoint("openai/gpt-4o", "openai/gpt-5")).toEqual({
			renamed: { "openai/gpt-4o": "openai/gpt-5" },
		})
	})

	it("does nothing when the alias is new", () => {
		expect(reconcileForAliasRepoint(undefined, "openai/gpt-5")).toBeNull()
	})

	it("does nothing when the target is unchanged", () => {
		// Re-saving the same alias must not rewrite keys.
		expect(reconcileForAliasRepoint("openai/gpt-4o", "openai/gpt-4o")).toBeNull()
	})

	it("lowercases the old name, which is how keys store it", () => {
		expect(reconcileForAliasRepoint("OpenAI/GPT-4o", "openai/gpt-5")).toEqual({
			renamed: { "openai/gpt-4o": "openai/gpt-5" },
		})
	})
})

function aliasHarness(initial: Record<string, string> = {}) {
	const store = { ...initial }
	const reconciled: Array<{ removed?: string[]; renamed?: Record<string, string> }> = []
	const aliases = makeModelAliases({
		aliases: {
			async list() {
				return { ...store }
			},
			async set(alias, model) {
				store[alias] = model
			},
			async remove(alias) {
				delete store[alias]
			},
		},
		reconciler: {
			async reconcile(change) {
				reconciled.push(change)
				return { emptied: change.removed ? ["key-a"] : [] }
			},
		},
	})
	return { aliases, store, reconciled }
}

describe("modelAliases.set", () => {
	it("keys the map by alias, which is the shape the readers use", async () => {
		// `PUT /api/models` keyed it by model and `PUT /api/models/alias` by alias,
		// so the same request produced two different map entries.
		const h = aliasHarness()
		await h.aliases.set({ model: "openai/gpt-4o", alias: "fast" })
		expect(h.store).toEqual({ fast: "openai/gpt-4o" })
	})

	it("reconciles when re-pointing an existing alias", async () => {
		const h = aliasHarness({ fast: "openai/gpt-4o" })
		await h.aliases.set({ model: "openai/gpt-5", alias: "fast" })
		expect(h.reconciled).toEqual([{ renamed: { "openai/gpt-4o": "openai/gpt-5" } }])
	})

	it("does not reconcile a brand-new alias", async () => {
		const h = aliasHarness()
		await h.aliases.set({ model: "openai/gpt-4o", alias: "fast" })
		expect(h.reconciled).toEqual([])
	})

	it("refuses an empty model or alias", async () => {
		const h = aliasHarness()
		await expect(h.aliases.set({ model: "", alias: "fast" })).rejects.toMatchObject({
			code: "VALIDATION",
		})
	})

	it("trims the values it stores", async () => {
		const h = aliasHarness()
		await h.aliases.set({ model: "  openai/gpt-4o  ", alias: "  fast  " })
		expect(h.store).toEqual({ fast: "openai/gpt-4o" })
	})
})

describe("modelAliases.remove", () => {
	it("reports the keys left with nothing to call", async () => {
		const h = aliasHarness({ fast: "openai/gpt-4o" })
		expect(await h.aliases.remove("fast")).toEqual({ keysLeftForReview: ["key-a"] })
		expect(h.store).toEqual({})
	})

	it("refuses a blank alias", async () => {
		const h = aliasHarness()
		await expect(h.aliases.remove("  ")).rejects.toMatchObject({ code: "VALIDATION" })
	})
})

describe("sanitizeCaps", () => {
	const keys = ["vision", "reasoning", "audio"]

	it("keeps only known keys with boolean values", () => {
		expect(
			sanitizeCaps({ vision: true, reasoning: "false", audio: false, extra: true }, keys),
		).toEqual({
			vision: true,
			audio: false,
		})
	})

	it("returns null when nothing survives", () => {
		// The reader then falls back to the name heuristic, which is better than a
		// row that claims every capability is off.
		expect(sanitizeCaps({ nope: true }, keys)).toBeNull()
		expect(sanitizeCaps(null, keys)).toBeNull()
		expect(sanitizeCaps("vision", keys)).toBeNull()
	})

	it("refuses a string where a boolean belongs", () => {
		// `"false"` is truthy, so storing it would make `if (caps.vision)` pass.
		expect(sanitizeCaps({ vision: "false" }, keys)).toBeNull()
	})
})

describe("sanitizeTransport", () => {
	const known = (value: string) => value === "http" || value === "websocket"

	it("keeps a known transport on an stt model", () => {
		expect(sanitizeTransport("http", "stt", known)).toBe("http")
		expect(sanitizeTransport("  websocket  ", "stt", known)).toBe("websocket")
	})

	it("drops an unknown transport", () => {
		expect(sanitizeTransport("carrier-pigeon", "stt", known)).toBeNull()
	})

	it("drops a transport on any non-stt type", () => {
		expect(sanitizeTransport("http", "llm", known)).toBeNull()
	})
})

describe("readCustomModel", () => {
	const keys = ["vision"]
	const known = () => true

	it("requires a provider alias and an id", () => {
		expect(readCustomModel({ providerAlias: "", id: "m" }, keys, known)).toMatchObject({
			code: "VALIDATION",
		})
		expect(readCustomModel({ providerAlias: "p", id: " " }, keys, known)).toMatchObject({
			code: "VALIDATION",
		})
	})

	it("defaults the type to llm", () => {
		const result = readCustomModel({ providerAlias: "p", id: "m" }, keys, known)
		expect(isCustomModelRefusal(result)).toBe(false)
		if (!isCustomModelRefusal(result)) expect(result.type).toBe("llm")
	})

	it("normalises the accepted fields", () => {
		const result = readCustomModel(
			{ providerAlias: " p ", id: " m ", type: " stt ", caps: { vision: true }, transport: "http" },
			keys,
			known,
		)
		expect(isCustomModelRefusal(result)).toBe(false)
		if (!isCustomModelRefusal(result)) {
			expect(result).toMatchObject({
				providerAlias: "p",
				id: "m",
				type: "stt",
				transport: "http",
				caps: { vision: true },
			})
		}
	})
})

describe("customModels.remove", () => {
	it("reconciles both the bare and provider-qualified spellings", async () => {
		// A key may hold the model either way, and missing one leaves it pointing
		// at a model that no longer exists.
		const reconciled: Array<{ removed?: string[] }> = []
		const removed: Array<{ providerAlias: string; id: string; type: string }> = []
		const models = makeCustomModels({
			models: {
				async list() {
					return []
				},
				async add() {
					return {}
				},
				async remove(fields) {
					removed.push(fields)
				},
			},
			reconciler: {
				async reconcile(change) {
					reconciled.push(change)
					return { emptied: ["k1"] }
				},
			},
		})
		const result = await models.remove({ providerAlias: "ocg", id: "gpt-4o", type: "llm" })
		expect(removed).toEqual([{ providerAlias: "ocg", id: "gpt-4o", type: "llm" }])
		expect(reconciled).toEqual([{ removed: ["gpt-4o", "ocg/gpt-4o"] }])
		expect(result).toEqual({ keysLeftForReview: ["k1"] })
	})
})
