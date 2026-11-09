/**
 * "+ Add All Active Models" must offer what the picker offers.
 *
 * The button used to walk the static provider registry over connection rows, which
 * silently dropped everything the picker knows from runtime data — most visibly
 * OpenCode Free (`oc`), a no-auth provider that owns no connection row and whose
 * usable ids mostly come from /api/models/custom. The cases below pin the shared
 * resolver to the picker's rules, then pin the card to the resolver so the two
 * cannot drift apart again.
 */
import fs from "node:fs"
import { describe, expect, it } from "vitest"
import {
	buildModelGroups,
	collectModelValues,
	NO_AUTH_PROVIDER_IDS,
} from "../../apps/web/src/shared/utils/selectableModels.ts"

const EMPTY = {
	connections: [],
	allConnections: [],
	modelAliases: {},
	customModels: [],
	disabledModels: {},
}

describe("buildModelGroups / collectModelValues", () => {
	it("includes a no-auth free provider that has no connection row", () => {
		expect(NO_AUTH_PROVIDER_IDS).toContain("opencode")

		const values = collectModelValues(buildModelGroups(EMPTY))

		// The static registry must survive zero connections. Assert on ids this fork's
		// registry actually declares — upstream's test pins muse-spark, which is not in
		// our model list, so the shape ("the oc provider shows up with no connection")
		// is what carries over, not their exact catalogue.
		expect(values).toContain("oc/union-alpha")
		expect(values).toContain("oc/beam-free")
		expect(values.filter((value) => value.startsWith("oc/")).length).toBeGreaterThan(1)
	})

	it("includes custom models registered under the provider alias", () => {
		const values = collectModelValues(
			buildModelGroups({
				...EMPTY,
				customModels: [
					{ providerAlias: "oc", id: "big-pickle", type: "llm", name: "big-pickle" },
					{ providerAlias: "oc", id: "glm-5.3-flash-free", type: "llm", name: "glm-5.3-flash-free" },
				],
			}),
		)

		expect(values).toContain("oc/big-pickle")
		expect(values).toContain("oc/glm-5.3-flash-free")
	})

	it("includes a user alias for a passthrough provider", () => {
		const values = collectModelValues(
			buildModelGroups({ ...EMPTY, modelAliases: { "oc/beam-free": "oc/beam-free" } }),
		)
		expect(values).toContain("oc/beam-free")
	})

	it("skips models disabled for the provider", () => {
		const values = collectModelValues(
			buildModelGroups({
				...EMPTY,
				customModels: [{ providerAlias: "oc", id: "big-pickle", type: "llm" }],
				disabledModels: { oc: ["big-pickle", "union-alpha"] },
			}),
		)

		expect(values).not.toContain("oc/big-pickle")
		expect(values).not.toContain("oc/union-alpha")
		expect(values).toContain("oc/beam-free")
	})

	it("honours a disabled list keyed by provider id rather than alias", () => {
		const values = collectModelValues(
			buildModelGroups({ ...EMPTY, disabledModels: { opencode: ["union-alpha"] } }),
		)
		expect(values).not.toContain("oc/union-alpha")
	})

	it("routes connections through their provider alias", () => {
		const conn = { id: "c1", provider: "opencode", isActive: true }
		const values = collectModelValues(
			buildModelGroups({ ...EMPTY, connections: [conn], allConnections: [conn] }),
		)

		// No-auth providers are always offered, so the assertion is that the
		// connection's models resolve under the routing alias, not that they are unique.
		expect(values).toContain("oc/union-alpha")
		expect(values.filter((value) => value.startsWith("oc/")).length).toBeGreaterThan(1)
	})

	it("drops providers whose connections are all deactivated", () => {
		const values = collectModelValues(
			buildModelGroups({
				...EMPTY,
				allConnections: [{ id: "c1", provider: "gemini", isActive: false }],
			}),
		)
		expect(values.some((value) => value.startsWith("gemini/"))).toBe(false)
	})

	it("includes live per-account catalogue models that are not in the registry", () => {
		const conn = { id: "c1", provider: "cursor", isActive: true }
		const values = collectModelValues(
			buildModelGroups({
				...EMPTY,
				connections: [conn],
				allConnections: [conn],
				liveModels: { cursor: [{ id: "live-only-model", name: "Live Only" }] },
			}),
		)
		expect(values).toContain("cu/live-only-model")
	})

	it("returns unique values only", () => {
		const values = collectModelValues(
			buildModelGroups({
				...EMPTY,
				customModels: [
					{ providerAlias: "oc", id: "dup-model", type: "llm" },
					{ providerAlias: "oc", id: "dup-model", type: "llm" },
				],
			}),
		)
		expect(values.filter((value) => value === "oc/dup-model")).toHaveLength(1)
	})

	it("tolerates empty and missing inputs", () => {
		expect(collectModelValues(buildModelGroups())).toEqual(expect.any(Array))
		expect(collectModelValues({})).toEqual([])
		expect(collectModelValues(buildModelGroups({}))).toEqual(expect.any(Array))
	})
})

describe("the pi card resolves through the shared builder", () => {
	const cardSrc = fs.readFileSync(
		new URL(
			"../../apps/web/src/app/(dashboard)/dashboard/cli-tools/components/GenericCliToolCard.tsx",
			import.meta.url,
		),
		"utf-8",
	)

	it("imports the resolver instead of walking the registry itself", () => {
		expect(cardSrc).toContain("buildModelGroups")
		expect(cardSrc).toContain("collectModelValues")
		expect(cardSrc).not.toMatch(/getModelsByProviderId\(conn\.provider\)/)
		expect(cardSrc).not.toContain("PROVIDER_ID_TO_ALIAS")
	})

	it("reads the runtime sources the picker reads", () => {
		expect(cardSrc).toContain("/api/models/custom")
		expect(cardSrc).toContain("/api/models/disabled")
		expect(cardSrc).toContain("/api/models/alias")
		expect(cardSrc).toContain("LIVE_CATALOG_PROVIDERS")
	})

	it("is not gated on having a connection, because no-auth providers need none", () => {
		expect(cardSrc).not.toMatch(
			/\{activeProviders\?\.length > 0 && \(\s*<Button[\s\S]{0,200}handleAddAllActiveModels/,
		)
	})

	it("resolves at click time rather than at render", () => {
		expect(cardSrc).toMatch(/const handleAddAllActiveModels = async \(\)/)
	})
})
