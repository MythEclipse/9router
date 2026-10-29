import { describe, expect, it } from "vitest"

import {
	type ModelCatalogueDependencies,
	makeModelCatalogue,
} from "../../apps/api/src/application/models/list-models.ts"
import type {
	CatalogueEntry,
	LiveCatalogueEntry,
	ModelCataloguePort,
} from "../../apps/api/src/application/models/ports.ts"

const CAPS = {
	vision: false,
	search: false,
	reasoning: false,
	contextWindow: 8192,
	maxOutput: 4096,
}

interface Fixture {
	curated?: CatalogueEntry[]
	live?: LiveCatalogueEntry[]
	aliases?: Record<string, string>
	disabled?: Record<string, string[]>
	custom?: Array<Record<string, unknown>>
	studios?: Array<Record<string, unknown>>
	combos?: Array<{ name: string; models?: string[]; contextWindow?: number }>
	adaptive?: { enabled?: boolean; models?: string[] }
	/** Makes the settings read throw, which must not take the picker down. */
	pluginsThrow?: boolean
	capabilities?: Record<string, typeof CAPS>
	/** Provider alias → provider id, for the capability-table lookup. */
	providerIds?: Record<string, string>
	aggregate?: Record<string, unknown> | null
}

function build(fixture: Fixture = {}) {
	const catalogue: ModelCataloguePort = {
		async curated() {
			return fixture.curated ?? []
		},
		async liveFree() {
			return fixture.live ?? []
		},
		capabilities(provider, model) {
			return fixture.capabilities?.[`${provider}/${model}`] ?? CAPS
		},
		providerIdOf(alias) {
			return fixture.providerIds?.[alias] ?? alias
		},
		aggregateCombo() {
			return fixture.aggregate === undefined ? { ...CAPS } : fixture.aggregate
		},
		displayName(model, fallback) {
			return fallback || model
		},
		generateId: () => "gen",
		normalizeLogo: () => null,
		async rejectUrl() {
			return null
		},
		capabilityKeys: () => [],
		sttTransports: () => [],
	}

	const deps: ModelCatalogueDependencies = {
		catalogue,
		aliases: {
			async list() {
				return fixture.aliases ?? {}
			},
			async set() {},
			async remove() {},
		},
		customModels: {
			async list() {
				return fixture.custom ?? []
			},
			async add() {
				return {}
			},
			async remove() {},
		},
		studios: {
			async list() {
				return fixture.studios ?? []
			},
			async find() {
				return null
			},
			async save() {
				return {}
			},
			async remove() {},
		},
		combos: {
			async list() {
				return fixture.combos ?? []
			},
		},
		disabledModels: {
			async list() {
				return fixture.disabled ?? {}
			},
		},
		plugins: {
			async read() {
				if (fixture.pluginsThrow) throw new Error("settings unavailable")
				return { adaptiveThinking: fixture.adaptive }
			},
		},
	}
	return makeModelCatalogue(deps)
}

describe("modelCatalogue.list — curated rows", () => {
	it("builds full and routed names from the provider alias", async () => {
		const list = await build({
			curated: [{ provider: "ocg", model: "gpt-4o", name: "GPT-4o" }],
			providerIds: { ocg: "opencode-gateway" },
		}).list()
		expect(list).toHaveLength(1)
		expect(list[0]).toMatchObject({
			fullModel: "ocg/gpt-4o",
			routedModel: "opencode-gateway/gpt-4o",
			name: "GPT-4o",
			alias: "gpt-4o",
		})
	})

	it("hides a model disabled under either spelling", async () => {
		// The panel writes the alias, the older code wrote the provider id; a row
		// disabled under one must not reappear.
		const list = await build({
			curated: [
				{ provider: "ocg", model: "a" },
				{ provider: "ocg", model: "b" },
			],
			providerIds: { ocg: "opencode-gateway" },
			disabled: { "opencode-gateway": ["a"] },
		}).list()
		expect(list.map((row) => row.model)).toEqual(["b"])
	})

	it("uses the stored alias when there is one", async () => {
		const list = await build({
			curated: [{ provider: "p", model: "gpt-4o" }],
			aliases: { "p/gpt-4o": "fast" },
		}).list()
		expect(list[0]?.alias).toBe("fast")
	})
})

describe("modelCatalogue.list — live free catalogue", () => {
	it("merges models the build-time registry does not have", async () => {
		const list = await build({
			curated: [{ provider: "free", model: "known" }],
			live: [
				{ alias: "free", model: "known" },
				{ alias: "free", model: "new", contextLength: 32000 },
			],
		}).list()
		expect(list.map((row) => row.model)).toEqual(["known", "new"])
		expect(list[1]).toMatchObject({ liveSuggested: true, caps: { contextWindow: 32000 } })
	})
})

describe("modelCatalogue.list — custom models", () => {
	it("drops a shadow instead of overwriting the real row", async () => {
		// A custom row storing only {vision} lands later in the array, and the
		// client's last-write-wins map would then serve the thinner caps for the
		// real model.
		const list = await build({
			curated: [{ provider: "ocg", model: "gpt-4o" }],
			custom: [{ providerAlias: "ocg", id: "gpt-4o", type: "llm", caps: { vision: true } }],
		}).list()
		expect(list).toHaveLength(1)
		expect(list[0]?.caps).toEqual(CAPS)
	})

	it("adds a custom model the registry does not list", async () => {
		const list = await build({
			custom: [{ providerAlias: "mine", id: "local-7b", type: "llm", name: "Local 7B" }],
		}).list()
		expect(list[0]).toMatchObject({ fullModel: "mine/local-7b", name: "Local 7B" })
	})

	it("lets a stored cap override the heuristic", async () => {
		const list = await build({
			custom: [{ providerAlias: "mine", id: "m", type: "llm", caps: { vision: true } }],
		}).list()
		expect(list[0]?.caps.vision).toBe(true)
	})

	it("resolves capabilities by provider id, not the UI alias", async () => {
		// The capability tables are keyed by id; `ocg` misses the provider-scoped
		// entries that `opencode-gateway` hits.
		const list = await build({
			custom: [{ providerAlias: "ocg", id: "m", type: "llm" }],
			providerIds: { ocg: "opencode-gateway" },
			capabilities: { "opencode-gateway/m": { ...CAPS, vision: true } },
		}).list()
		expect(list[0]?.caps.vision).toBe(true)
	})

	it("skips a row with no id and a non-llm type", async () => {
		const list = await build({
			custom: [{ providerAlias: "p" }, { providerAlias: "p", id: "a", type: "stt" }],
		}).list()
		expect(list).toEqual([])
	})
})

describe("modelCatalogue.list — studio models", () => {
	it("marks the call name as routable on its own", async () => {
		const list = await build({
			studios: [{ provider: "openai", model: "gpt-4o", callName: "fast", displayName: "Fast" }],
		}).list()
		expect(list[0]).toMatchObject({
			fullModel: "openai/fast",
			routedModel: "fast",
			alias: "fast",
			name: "Fast",
			isStudio: true,
		})
	})
})

describe("modelCatalogue.list — combos", () => {
	it("aggregates member capabilities", async () => {
		const list = await build({
			combos: [{ name: "smart", models: ["openai/gpt-4o", "anthropic/claude"], contextWindow: 0 }],
		}).list()
		expect(list[0]).toMatchObject({ provider: "combo", model: "smart", isCombo: true })
	})

	it("skips a combo with no members", async () => {
		const list = await build({ combos: [{ name: "empty", models: [] }] }).list()
		expect(list).toEqual([])
	})

	it("skips a combo whose members add up to nothing", async () => {
		const list = await build({
			combos: [{ name: "x", models: ["unknown/model"] }],
			aggregate: null,
		}).list()
		expect(list).toEqual([])
	})
})

describe("modelCatalogue.list — plugin marks", () => {
	it("adds no mark when the plugin is off", async () => {
		const list = await build({
			curated: [{ provider: "p", model: "m" }],
			adaptive: { enabled: false, models: ["p/m"] },
		}).list()
		expect(list[0]?.pluginMarks).toEqual([])
	})

	it("marks a model whose full name is listed", async () => {
		const list = await build({
			curated: [{ provider: "p", model: "m" }],
			adaptive: { enabled: true, models: ["p/m"] },
		}).list()
		expect(list[0]?.pluginMarks).toEqual(["adaptiveThinking"])
	})

	it("marks a model whose routed name is listed", async () => {
		// The plugin may be configured against the provider id, while the row's
		// own provider is the alias; both spellings have to match.
		const list = await build({
			curated: [{ provider: "ocg", model: "m" }],
			providerIds: { ocg: "opencode-gateway" },
			adaptive: { enabled: true, models: ["opencode-gateway/m"] },
		}).list()
		expect(list[0]?.pluginMarks).toEqual(["adaptiveThinking"])
	})

	it("marks a model whose bare name is listed", async () => {
		const list = await build({
			curated: [{ provider: "p", model: "m" }],
			adaptive: { enabled: true, models: ["m"] },
		}).list()
		expect(list[0]?.pluginMarks).toEqual(["adaptiveThinking"])
	})

	it("turns the capability on along with the mark", async () => {
		// Adaptive thinking is a reasoning feature; a mark without the capability
		// would draw a badge the router does not honour.
		const list = await build({
			curated: [{ provider: "p", model: "m" }],
			adaptive: { enabled: true, models: ["m"] },
		}).list()
		expect(list[0]?.caps).toMatchObject({ reasoning: true, adaptiveThinking: true })
	})

	it("marks a studio model by its call name or its target", async () => {
		const byCallName = await build({
			studios: [{ provider: "p", model: "target", callName: "mine" }],
			adaptive: { enabled: true, models: ["mine"] },
		}).list()
		expect(byCallName[0]?.pluginMarks).toEqual(["adaptiveThinking"])

		const byTarget = await build({
			studios: [{ provider: "p", model: "target", callName: "mine" }],
			adaptive: { enabled: true, models: ["p/target"] },
		}).list()
		expect(byTarget[0]?.pluginMarks).toEqual(["adaptiveThinking"])
	})

	it("marks a combo from its members", async () => {
		// The plugin selection was made per model when the combo was configured,
		// so a member's mark makes the combo carry it.
		const list = await build({
			combos: [{ name: "smart", models: ["p/m"] }],
			adaptive: { enabled: true, models: ["p/m"] },
		}).list()
		expect(list[0]?.pluginMarks).toEqual(["adaptiveThinking"])
	})
})

describe("modelCatalogue.list — plugin read failure", () => {
	it("still lists models when the settings read throws", async () => {
		// A settings read that fails must not take the whole picker down; the
		// badges are the only thing lost.
		const list = await build({
			curated: [{ provider: "p", model: "m" }],
			pluginsThrow: true,
		}).list()
		expect(list).toHaveLength(1)
		expect(list[0]?.pluginMarks).toEqual([])
	})
})
