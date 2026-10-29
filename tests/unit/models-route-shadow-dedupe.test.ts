// A custom-model row created before a model existed in the registry (dashboard
// "add custom model") stores thin caps — {vision, reasoning}, no contextWindow —
// under the UI alias (`ocg|claude-haiku-5-5|llm`). Once the registry gains the
// model, /api/models lists the real entry (fullModel opencode-go/…) AND the
// custom shadow (fullModel ocg/…), both with routedModel ocg/claude-haiku-5-5.
// The client's useModelCaps builds byFull[routedModel] last-write-wins, so the
// shadow (resolved via the alias `ocg`, which misses the provider-scoped 1M
// entry and falls back to *claude*haiku* → 200k/64k) overwrote the real 1M/128k
// caps and dragged every combo containing the seat down to 200k.
//
// Two behaviors pinned here (drive the route handler with mocked repos):
// 1. a custom row whose providerAlias/id collides with a listed routedModel is
//    dropped (read-time filter; the kv row itself is untouched);
// 2. surviving custom rows resolve caps through the provider id, not the alias.
// The rules under test now live in `apps/api/src/application/models/list-models.ts`
// (they were in the route). The harness below wires the real capability tables,
// the real registry (AI_MODELS) and the real alias map, and fakes only the two
// stores the test itself changes — so the assertions still exercise a real
// collision against the real 1M/128k registry entry.
import { beforeEach, describe, expect, it, vi } from "vitest"

const stores = vi.hoisted(() => ({
	custom: [] as Array<Record<string, unknown>>,
	disabled: {} as Record<string, string[]>,
}))

import { makeModelCatalogue } from "9router-api/application/models/list-models"
import { catalogueHost, registryHost } from "@/lib/modelRegistryHost"

function catalogue() {
	return makeModelCatalogue({
		catalogue: {
			async curated() {
				return catalogueHost.curatedModels()
			},
			async liveFree() {
				return []
			},
			capabilities: (provider, model) => catalogueHost.capabilities(provider, model),
			providerIdOf: (alias) => catalogueHost.providerIdOf(alias),
			aggregateCombo: (members, byName, window) =>
				catalogueHost.aggregateCombo(members, byName, window),
			displayName: (model, fallback) => catalogueHost.displayName(model, fallback),
			generateId: () => catalogueHost.generateId(),
			normalizeLogo: (value) => catalogueHost.normalizeLogo(value),
			rejectUrl: (raw, local) => catalogueHost.rejectUrl(raw, local),
			capabilityKeys: () => catalogueHost.capabilityKeys(),
			sttTransports: () => catalogueHost.sttTransports(),
		},
		aliases: registryHost.aliases,
		customModels: {
			async list() {
				return stores.custom
			},
			async add() {
				return {}
			},
			async remove() {},
		},
		studios: {
			async list() {
				return []
			},
			async find() {
				return null
			},
			async save() {
				return {}
			},
			async remove() {},
		},
		combos: registryHost.combos,
		disabledModels: {
			async list() {
				return stores.disabled
			},
		},
		plugins: {
			async read() {
				return {}
			},
		},
	})
}

async function fetchModels() {
	return catalogue().list()
}

beforeEach(() => {
	stores.custom = []
	stores.disabled = {}
})

describe("/api/models — custom-model shadow dedupe", () => {
	it("drops the ocg/claude-haiku-5-5 shadow and keeps the 1M registry entry", async () => {
		stores.custom = [
			{
				providerAlias: "ocg",
				id: "claude-haiku-5-5",
				type: "llm",
				name: "claude-haiku-5-5",
				caps: { vision: true, reasoning: true },
			},
		]

		const models = await fetchModels()
		const routed = models.filter(
			(m) =>
				m.routedModel === "ocg/claude-haiku-5-5" || m.fullModel === "opencode-go/claude-haiku-5-5",
		)

		expect(routed).toHaveLength(1)
		expect(routed[0].fullModel).toBe("opencode-go/claude-haiku-5-5")
		expect(routed[0].caps.contextWindow).toBe(1000000)
		expect(routed[0].caps.maxOutput).toBe(128000)
	})

	it("keeps non-colliding custom rows and resolves their caps by provider id", async () => {
		stores.custom = [
			// does not collide: registry has no such id under a routed alias
			{ providerAlias: "cmc", id: "some-totally-custom-model", type: "llm", name: "x", caps: {} },
		]

		const models = await fetchModels()
		const kept = models.find((m) => m.fullModel === "cmc/some-totally-custom-model")
		expect(kept).toBeDefined()
		// `cmc` maps to commandcode; the commandcode branch (1M/384k for unlisted
		// models) must fire — an alias lookup would miss it entirely and fall to
		// the 200k floor.
		expect(kept.caps.contextWindow).toBe(1000000)
		expect(kept.caps.maxOutput).toBe(384000)
	})
})
