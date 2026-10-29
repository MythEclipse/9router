import { describe, expect, it } from "vitest"

import {
	isPluginPayload,
	normaliseCustomPlugins,
} from "../../apps/api/src/domain/custom-plugins.ts"

const CATALOGUE = ["adaptiveThinking"]

describe("normaliseCustomPlugins", () => {
	it("returns every catalogue key even when nothing is stored", () => {
		const { customPlugins } = normaliseCustomPlugins(undefined, CATALOGUE)
		expect(customPlugins).toEqual({ adaptiveThinking: { enabled: false, models: [] } })
	})

	it("reads the stored entry", () => {
		const { customPlugins } = normaliseCustomPlugins(
			{ adaptiveThinking: { enabled: true, models: ["gpt-4o"] } },
			CATALOGUE,
		)
		expect(customPlugins.adaptiveThinking).toEqual({ enabled: true, models: ["gpt-4o"] })
	})

	it("survives a partially written row instead of throwing at page load", () => {
		// One entry has the wrong shape. It must still yield a usable snapshot:
		// refusing to render the settings page would hide every other entry.
		const { customPlugins } = normaliseCustomPlugins({ adaptiveThinking: "on" }, [
			...CATALOGUE,
			"secondPlugin",
		])
		expect(customPlugins.adaptiveThinking).toEqual({ enabled: false, models: [] })
		expect(customPlugins.secondPlugin).toEqual({ enabled: false, models: [] })
	})

	it("treats enabled as strictly true, not merely truthy", () => {
		const { customPlugins } = normaliseCustomPlugins(
			{ adaptiveThinking: { enabled: "yes" } },
			CATALOGUE,
		)
		expect(customPlugins.adaptiveThinking).toEqual({ enabled: false, models: [] })
	})

	it("drops non-string model entries rather than stringifying them", () => {
		const { customPlugins } = normaliseCustomPlugins(
			{ adaptiveThinking: { enabled: true, models: ["gpt-4o", 7, null, "", { a: 1 }] } },
			CATALOGUE,
		)
		expect(customPlugins.adaptiveThinking.models).toEqual(["gpt-4o"])
	})

	it("does not treat a string models field as an array of one", () => {
		// The old reader did `Array.isArray(...) ? ... : []`, so a caller's typo
		// looked like a plugin with no models instead of a malformed entry.
		const { customPlugins } = normaliseCustomPlugins(
			{ adaptiveThinking: { enabled: true, models: "gpt-4o" } },
			CATALOGUE,
		)
		expect(customPlugins.adaptiveThinking.models).toEqual([])
	})

	it("reports keys outside the catalogue instead of silently dropping them", () => {
		const { unknownKeys } = normaliseCustomPlugins(
			{ adaptiveThinking: { enabled: true }, adaptiveThinkin: { enabled: true } },
			CATALOGUE,
		)
		expect(unknownKeys).toEqual(["adaptiveThinkin"])
	})
})

describe("isPluginPayload", () => {
	it("accepts a plain object with a customPlugins object", () => {
		expect(isPluginPayload({ customPlugins: {} })).toBe(true)
	})

	it("rejects an array body, which the old typeof check accepted", () => {
		// `[1,2,3]` reaches the normaliser as an object with no catalogue keys, so
		// the old route answered 200 and stored every plugin as disabled.
		expect(isPluginPayload([1, 2, 3])).toBe(false)
	})

	it("rejects a missing or non-object customPlugins", () => {
		expect(isPluginPayload({})).toBe(false)
		expect(isPluginPayload({ customPlugins: "on" })).toBe(false)
		expect(isPluginPayload({ customPlugins: [] })).toBe(false)
	})

	it("rejects null and undefined", () => {
		expect(isPluginPayload(null)).toBe(false)
		expect(isPluginPayload(undefined)).toBe(false)
	})
})
