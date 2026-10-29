import { describe, expect, test } from "vitest"
import {
	activeModelLocks,
	comboContextWindow,
	comboStatus,
	distinctCallPaths,
	enabledPluginSources,
	indexProviders,
	isModelDisabled,
	lockKey,
	modelLockStatus,
	normalizeModelStatus,
	pluginMarkIds,
	providerKeysOf,
	providerStatus,
	readContextWindow,
	resolvePluginMarks,
	worstModelStatus,
} from "../../apps/api/src/domain/available-models"

const NOW = Date.parse("2026-10-29T12:00:00Z")
const spellings = {
	aliasOf: (p: string) => (p === "github" ? "gh" : p),
	idOf: (p: string) => (p === "gh" ? "github" : p),
}

function conn(overrides: Record<string, unknown>) {
	return { provider: "openai", isActive: true, ...overrides }
}

describe("model status ordering", () => {
	test("ready is the default and the least bad", () => {
		expect(normalizeModelStatus(undefined)).toBe("ready")
		expect(worstModelStatus([])).toBe("ready")
		expect(worstModelStatus(["ready", "limited"])).toBe("limited")
		expect(worstModelStatus(["ready", "limited", "cooldown"])).toBe("cooldown")
		expect(worstModelStatus(["cooldown", "unavailable"])).toBe("unavailable")
	})

	test("normalises case and surrounding space", () => {
		expect(normalizeModelStatus("  COOLDOWN ")).toBe("cooldown")
	})

	test("an unknown status does not hide the model", () => {
		expect(normalizeModelStatus("degraded")).toBe("ready")
	})
})

describe("activeModelLocks", () => {
	test("keeps only unexpired locks", () => {
		const locks = activeModelLocks(
			{
				modelLock_gpt_4o: "2026-10-29T13:00:00Z",
				modelLock_claude: "2026-10-29T11:00:00Z",
			},
			NOW,
		)
		expect(locks).toEqual(["gpt_4o"])
	})

	test("an empty suffix means every model, as a marker", () => {
		expect(activeModelLocks({ modelLock_: "2026-10-30T00:00:00Z" }, NOW)).toEqual(["__all"])
	})

	test("lowercases the model id and ignores unparseable expiries", () => {
		expect(activeModelLocks({ modelLock_GPT_4O: "2026-10-30T00:00:00Z" }, NOW)).toEqual(["gpt_4o"])
		expect(activeModelLocks({ modelLock_gpt_4o: "not-a-date" }, NOW)).toEqual([])
	})

	test("ignores non-lock columns and empty values", () => {
		expect(activeModelLocks({ testStatus: "unavailable", modelLock_x: "" }, NOW)).toEqual([])
	})
})

describe("indexProviders", () => {
	test("counts active and unavailable connections separately", () => {
		const index = indexProviders([conn({}), conn({ testStatus: "unavailable" }), conn({})], NOW)
		expect(index.health.get("openai")).toEqual({ active: 2, unavailable: 1 })
	})

	test("an inactive connection contributes nothing", () => {
		// A disabled connection serves no traffic; counting it would mark the provider ready.
		const index = indexProviders([conn({ isActive: false })], NOW)
		expect(index.health.has("openai")).toBe(false)
	})

	test("provider names fold to lowercase", () => {
		const index = indexProviders([conn({ provider: "OpenAI" })], NOW)
		expect(index.health.get("openai")).toEqual({ active: 1, unavailable: 0 })
	})

	test("collects locks per provider", () => {
		const index = indexProviders(
			[
				conn({ modelLock_gpt_4o: "2026-10-30T00:00:00Z" }),
				conn({ modelLock_: "2026-10-30T00:00:00Z" }),
			],
			NOW,
		)
		expect(index.locks.get("openai")).toEqual(["gpt_4o", "__all"])
	})

	test("tolerates a missing or empty list", () => {
		expect(indexProviders(null, NOW).health.size).toBe(0)
		expect(indexProviders([], NOW).locks.size).toBe(0)
	})
})

describe("providerKeysOf", () => {
	test("offers the id, the alias and the reverse mapping", () => {
		expect(providerKeysOf("github", spellings).sort()).toEqual(["gh", "github"])
		expect(providerKeysOf("openai", spellings)).toEqual(["openai"])
	})

	test("drops blanks", () => {
		expect(providerKeysOf("  ", { aliasOf: () => null, idOf: () => undefined })).toEqual([])
	})
})

describe("providerStatus", () => {
	test("a provider with no connection row is ready, not unavailable", () => {
		// Credential-free providers serve without a row; reporting them unavailable hides
		// every free model from the card.
		expect(providerStatus("openrouter", indexProviders([], NOW), spellings)).toBe("ready")
	})

	test("a provider whose only connections are unavailable reports unavailable", () => {
		const index = indexProviders([conn({ testStatus: "unavailable" })], NOW)
		expect(providerStatus("openai", index, spellings)).toBe("unavailable")
	})

	test("one healthy connection is enough", () => {
		const index = indexProviders([conn({ testStatus: "unavailable" }), conn({})], NOW)
		expect(providerStatus("openai", index, spellings)).toBe("ready")
	})

	test("finds a provider filed under its other spelling", () => {
		const index = indexProviders([conn({ provider: "github", testStatus: "unavailable" })], NOW)
		expect(providerStatus("gh", index, spellings)).toBe("unavailable")
	})
})

describe("modelLockStatus", () => {
	test("no locks at all is ready", () => {
		expect(modelLockStatus("openai", "gpt-4o", indexProviders([], NOW), spellings)).toBe("ready")
	})

	test("a lock for every model is cooldown", () => {
		const index = indexProviders([conn({ modelLock_: "2026-10-30T00:00:00Z" })], NOW)
		expect(modelLockStatus("openai", "gpt-4o", index, spellings)).toBe("cooldown")
	})

	test("a lock naming this model is cooldown", () => {
		// The column suffix is the snake_cased model id, so the lookup must fold the same way.
		const index = indexProviders([conn({ modelLock_gpt_4o: "2026-10-30T00:00:00Z" })], NOW)
		expect(modelLockStatus("openai", "gpt-4o", index, spellings)).toBe("cooldown")
		expect(modelLockStatus("openai", "GPT-4O", index, spellings)).toBe("cooldown")
	})

	test("dotted and colon-separated ids fold to the same key", () => {
		expect(lockKey("claude-3.5-sonnet")).toBe("claude_3_5_sonnet")
		expect(lockKey("gpt:4o")).toBe("gpt_4o")
		expect(lockKey("  GPT-4O ")).toBe("gpt_4o")
		const anthropic = indexProviders(
			[conn({ provider: "anthropic", modelLock_claude_3_5_sonnet: "2026-10-30T00:00:00Z" })],
			NOW,
		)
		expect(modelLockStatus("anthropic", "claude-3.5-sonnet", anthropic, spellings)).toBe("cooldown")
		expect(modelLockStatus("anthropic", "claude-3-5-sonnet", anthropic, spellings)).toBe("cooldown")
		expect(modelLockStatus("anthropic", "claude-3.5-opus", anthropic, spellings)).toBe("limited")
	})

	test("a lock naming another model leaves this one limited, not ready", () => {
		const index = indexProviders([conn({ modelLock_claude: "2026-10-30T00:00:00Z" })], NOW)
		expect(modelLockStatus("openai", "gpt-4o", index, spellings)).toBe("limited")
	})

	test("an expired lock does not cool anything down", () => {
		const index = indexProviders([conn({ modelLock_gpt_4o: "2026-10-29T11:00:00Z" })], NOW)
		expect(modelLockStatus("openai", "gpt-4o", index, spellings)).toBe("ready")
	})

	test("an empty bare model never matches a named lock", () => {
		const index = indexProviders([conn({ modelLock_claude: "2026-10-30T00:00:00Z" })], NOW)
		expect(modelLockStatus("openai", "", index, spellings)).toBe("limited")
	})
})

describe("comboStatus", () => {
	const index = indexProviders(
		[
			conn({ provider: "openai" }),
			conn({ provider: "anthropic", testStatus: "unavailable" }),
			conn({ provider: "google", modelLock_: "2026-10-30T00:00:00Z" }),
		],
		NOW,
	)

	const comboNames = ["fast", "nested", "cycleA", "cycleB", "broken", "empty", "unknown"]
	const members: Record<string, readonly string[]> = {
		fast: ["openai/gpt-4o", "google/gemini"],
		nested: ["fast", "openai/gpt-4o"],
		cycleA: ["cycleB"],
		cycleB: ["cycleA"],
		broken: ["anthropic/claude"],
		empty: [],
		unknown: ["bare-model"],
	}
	const deps = {
		membersOf: (name: string) => members[name] ?? [],
		isCombo: (name: string) => comboNames.includes(name),
		providerStatusOf: (provider: string) => providerStatus(provider, index, spellings),
		modelLockStatusOf: (provider: string, bare: string) =>
			modelLockStatus(provider, bare, index, spellings),
	}

	test("rolls up the worst member", () => {
		expect(comboStatus("fast", deps)).toBe("cooldown")
		expect(comboStatus("broken", deps)).toBe("unavailable")
	})

	test("walks nested combos", () => {
		expect(comboStatus("nested", deps)).toBe("cooldown")
	})

	test("a cycle terminates instead of recursing forever", () => {
		expect(comboStatus("cycleA", deps)).toBe("ready")
	})

	test("an empty combo is ready, not unavailable", () => {
		expect(comboStatus("empty", deps)).toBe("ready")
	})

	test("a member with no provider prefix cannot be resolved", () => {
		expect(comboStatus("unknown", deps)).toBe("ready")
	})
})

describe("comboContextWindow", () => {
	const windows: Record<string, number> = {
		"openai/gpt-4o": 128_000,
		"openai/gpt-4o-mini": 32_000,
		"anthropic/claude": 200_000,
	}
	const comboNames = ["wide", "narrow", "nested", "partlyUnknown", "bare", "empty"]
	const members: Record<string, readonly string[]> = {
		wide: ["openai/gpt-4o", "anthropic/claude"],
		narrow: ["openai/gpt-4o", "openai/gpt-4o-mini"],
		nested: ["narrow", "anthropic/claude"],
		partlyUnknown: ["openai/gpt-4o", "mystery/model"],
		bare: ["gpt-4o"],
		empty: [],
	}
	const membersOf = (name: string) => members[name] ?? []
	const isCombo = (name: string) => comboNames.includes(name)
	// A bare id resolves through the same table, as the capability lookup does.
	const lookup = (provider: string, bare: string) =>
		windows[provider ? `${provider}/${bare}` : `openai/${bare}`] ?? null

	test("the smallest member wins", () => {
		expect(comboContextWindow("wide", membersOf, isCombo, lookup)).toBe(128_000)
		expect(comboContextWindow("narrow", membersOf, isCombo, lookup)).toBe(32_000)
	})

	test("nested combos are walked", () => {
		expect(comboContextWindow("nested", membersOf, isCombo, lookup)).toBe(32_000)
	})

	test("an unknown member is skipped, not counted as zero", () => {
		expect(comboContextWindow("partlyUnknown", membersOf, isCombo, lookup)).toBe(128_000)
	})

	test("a bare member id still resolves", () => {
		expect(comboContextWindow("bare", membersOf, isCombo, lookup)).toBe(128_000)
	})

	test("no known member yields null rather than a guess", () => {
		expect(comboContextWindow("empty", membersOf, isCombo, lookup)).toBe(null)
	})
})

describe("readContextWindow", () => {
	test("accepts a positive finite number", () => {
		expect(readContextWindow({ contextWindow: 128_000 })).toBe(128_000)
	})

	test("rejects zero, negatives, and junk", () => {
		expect(readContextWindow({ contextWindow: 0 })).toBe(null)
		expect(readContextWindow({ contextWindow: -1 })).toBe(null)
		expect(readContextWindow({ contextWindow: "big" })).toBe(null)
		expect(readContextWindow(null)).toBe(null)
	})
})

describe("plugin marks", () => {
	const sources = enabledPluginSources(
		{
			vision: { enabled: true, models: ["openai/gpt-4o", "combo/reader"] },
			audio: { enabled: false, models: ["openai/gpt-4o"] },
			search: { enabled: true, models: [] },
		},
		["vision", "audio", "search"],
	)

	test("only enabled plugins become sources", () => {
		expect(sources.map((s) => s.key)).toEqual(["vision", "search"])
	})

	test("a disabled plugin contributes no mark", () => {
		expect(resolvePluginMarks(["openai/gpt-4o"], sources)).toEqual(["vision"])
	})

	test("matches whichever spelling the plugin filed the model under", () => {
		expect(resolvePluginMarks(["combo/reader"], sources)).toEqual(["vision"])
		expect(resolvePluginMarks(["openai/gpt-4o", "gpt-4o"], sources)).toEqual(["vision"])
	})

	test("no matching plugin means no marks", () => {
		expect(resolvePluginMarks(["openai/o3"], sources)).toEqual([])
		expect(resolvePluginMarks([], sources)).toEqual([])
	})

	test("a combo row offers its own name and its members' ids", () => {
		expect(pluginMarkIds({ origin: "combo", model: "reader" }, ["openai/gpt-4o"])).toEqual([
			"reader",
			"combo/reader",
			"openai/gpt-4o",
		])
	})

	test("a provider row offers full, routed and bare ids", () => {
		const ids = pluginMarkIds(
			{
				origin: "provider",
				provider: "openai",
				model: "gpt-4o",
				fullModel: "openai/gpt-4o",
				routedModel: "openai/gpt-4o",
			},
			[],
		)
		expect(ids[0]).toBe("openai/gpt-4o")
		expect(ids).toContain("gpt-4o")
	})

	test("settings with no plugins at all yield no sources", () => {
		expect(enabledPluginSources(null, ["vision"])).toEqual([])
		expect(enabledPluginSources(undefined, [])).toEqual([]) // tolerated at runtime
	})
})

describe("distinctCallPaths", () => {
	test("collapses the same provider and model listed twice", () => {
		const rows = [
			{ provider: "openai", model: "gpt-4o" },
			{ provider: "OpenAI", model: "GPT-4o" },
		]
		expect(distinctCallPaths(rows)).toHaveLength(1)
	})

	test("keeps the same model behind different providers", () => {
		// Different call paths: the card disambiguates the label instead.
		const rows = [
			{ provider: "openai", model: "gpt-4o" },
			{ provider: "azure", model: "gpt-4o" },
		]
		expect(distinctCallPaths(rows)).toHaveLength(2)
	})

	test("falls back to the display name when there is no model", () => {
		const rows = [
			{ provider: "combo", name: "fast" },
			{ provider: "combo", name: "FAST" },
		]
		expect(distinctCallPaths(rows)).toHaveLength(1)
	})
})

describe("isModelDisabled", () => {
	test("reads the list under the alias", () => {
		expect(isModelDisabled({ gh: ["gpt-4o"] }, "github", "gpt-4o", spellings.aliasOf)).toBe(true)
	})

	test("reads the list under the id", () => {
		expect(isModelDisabled({ github: ["gpt-4o"] }, "github", "gpt-4o", spellings.aliasOf)).toBe(true)
	})

	test("a different model in the list does not disable this one", () => {
		expect(isModelDisabled({ gh: ["gpt-4o-mini"] }, "github", "gpt-4o", spellings.aliasOf)).toBe(
			false,
		)
	})

	test("an empty or missing record disables nothing", () => {
		expect(isModelDisabled(null, "openai", "gpt-4o", spellings.aliasOf)).toBe(false)
		expect(isModelDisabled({}, "openai", "gpt-4o", spellings.aliasOf)).toBe(false)
	})
})
