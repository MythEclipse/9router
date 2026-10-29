// Tests for apps/api/src/domain/model-catalogue.ts — how a raw upstream catalogue
// becomes picker entries, and which answer to give when the live one is missing.
//
// No existing test file covers this: the filters and the three repeated
// stale-or-fallback answers lived inline in
// apps/web/src/app/api/providers/suggested-models/route.ts and its filters.ts.
//
// User instruction, verbatim: "lanjut kenapa malah berhenti".

import { describe, expect, it } from "vitest"
import {
	type CatalogueFilters,
	degradedAnswer,
	fallbackFor,
	filterFor,
	liveAnswer,
	STALE_MESSAGE,
	toCatalogueArray,
	UNAVAILABLE_MESSAGE,
} from "../../apps/api/src/domain/model-catalogue.ts"

const catalogue: CatalogueFilters = {
	filters: {
		openai: (models) =>
			(Array.isArray(models) ? models : [])
				.filter((m) => typeof (m as { id?: unknown }).id === "string")
				.map((m) => ({ id: (m as { id: string }).id, name: (m as { id: string }).id })),
	},
	fallbacks: { openai: [{ id: "built-in", name: "built-in" }] },
}

describe("filterFor", () => {
	it("returns the filter for a known type", () => {
		expect(filterFor(catalogue, "openai")).toBeTypeOf("function")
	})

	it("returns null for an unknown type", () => {
		expect(filterFor(catalogue, "gemini")).toBeNull()
	})
})

describe("fallbackFor", () => {
	it("returns the built-in entries for a type that has them", () => {
		expect(fallbackFor(catalogue, "openai")).toEqual([{ id: "built-in", name: "built-in" }])
	})

	it("returns an empty list for a type with none", () => {
		expect(fallbackFor(catalogue, "unknown")).toEqual([])
	})
})

describe("toCatalogueArray", () => {
	it("passes a bare array through", () => {
		const list = [{ id: "a" }]
		expect(toCatalogueArray(list)).toBe(list)
	})

	it("passes an object through wrapped, so minimax-code's provider map survives", () => {
		// Its body is one object holding a `providers` map, not an array of models.
		const body = { providers: [{ providerId: "minimax" }] }
		expect(toCatalogueArray(body)).toEqual([body])
	})

	it("returns an empty array for null, a string or a number", () => {
		expect(toCatalogueArray(null)).toEqual([])
		expect(toCatalogueArray("nope")).toEqual([])
		expect(toCatalogueArray(7)).toEqual([])
	})
})

describe("liveAnswer", () => {
	const synced = { data: [{ id: "synced", name: "synced" }], syncedAt: "2026-10-01T00:00:00Z" }
	const builtIn = [{ id: "built-in", name: "built-in" }]

	it("reports a non-empty live list as live and not stale", () => {
		expect(liveAnswer([{ id: "live", name: "live" }], synced, builtIn)).toEqual({
			data: [{ id: "live", name: "live" }],
			source: "live",
			stale: false,
		})
	})

	it("treats an empty live list as a failure, not an empty success", () => {
		// A provider listing nothing at the moment must still show something, or the
		// suggested row blinks out and reads as "this provider has no models".
		expect(liveAnswer([], synced, builtIn).source).toBe("synced")
	})
})

describe("degradedAnswer", () => {
	const synced = { data: [{ id: "synced", name: "synced" }], syncedAt: "2026-10-01T00:00:00Z" }
	const builtIn = [{ id: "built-in", name: "built-in" }]

	it("prefers the stored copy over the built-in table", () => {
		const answer = degradedAnswer(synced, builtIn)
		expect(answer.data).toEqual(synced.data)
		expect(answer.source).toBe("synced")
		expect(answer.stale).toBe(true)
		expect(answer.message).toBe(STALE_MESSAGE)
		expect(answer.syncedAt).toBe("2026-10-01T00:00:00Z")
	})

	it("falls to the built-in table when no copy was stored", () => {
		const answer = degradedAnswer(null, builtIn)
		expect(answer.data).toEqual(builtIn)
		expect(answer.source).toBe("fallback")
		expect(answer.stale).toBe(false)
		expect(answer.message).toBe(UNAVAILABLE_MESSAGE)
		expect(answer).not.toHaveProperty("syncedAt")
	})

	it("ignores an empty stored copy", () => {
		// An empty copy is a stored failure, not a stored answer.
		expect(degradedAnswer({ data: [] }, builtIn).source).toBe("fallback")
	})
})
