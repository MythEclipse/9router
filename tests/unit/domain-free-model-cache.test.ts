import { describe, expect, it } from "vitest"
import {
	type CacheEntry,
	freeModelsFrom,
	MAX_STALE_MS,
	readCache,
} from "../../apps/api/src/domain/free-model-cache.ts"

const HOUR = 60 * 60 * 1000

describe("readCache", () => {
	const entry = (storedAt: number): CacheEntry<string[]> => ({ value: ["a"], storedAt })

	it("reports empty when nothing is stored", () => {
		expect(readCache(null, 1000, HOUR)).toEqual({ kind: "empty" })
		expect(readCache(undefined, 1000, HOUR)).toEqual({ kind: "empty" })
	})

	it("reports fresh inside the ttl", () => {
		expect(readCache(entry(0), HOUR - 1, HOUR)).toEqual({ kind: "fresh", value: ["a"] })
	})

	it("reports stale exactly at the ttl", () => {
		expect(readCache(entry(0), HOUR, HOUR)).toEqual({ kind: "stale", value: ["a"] })
	})

	it("reports stale just before the stale ceiling", () => {
		expect(readCache(entry(0), MAX_STALE_MS - 1, HOUR)).toEqual({ kind: "stale", value: ["a"] })
	})

	it("reports empty at the stale ceiling", () => {
		// A month-old catalogue is not evidence of the current free tier.
		expect(readCache(entry(0), MAX_STALE_MS, HOUR)).toEqual({ kind: "empty" })
	})

	it("distrusts a timestamp in the future", () => {
		expect(readCache(entry(10_000), 0, HOUR)).toEqual({ kind: "empty" })
	})
})

describe("freeModelsFrom", () => {
	it("keeps only the models marked free", () => {
		const models = freeModelsFrom([
			{ id: "a", name: "A", isFree: true, context_length: 100 },
			{ id: "b", name: "B", isFree: false, context_length: 200 },
			{ id: "c", name: "C" },
		])
		expect(models).toEqual([{ id: "a", name: "A", isFree: true, context_length: 100 }])
	})

	it("defaults a missing context length to 0", () => {
		const [model] = freeModelsFrom([{ id: "a", isFree: true }])
		expect(model.context_length).toBe(0)
	})

	it("defaults a non-numeric context length to 0", () => {
		const [model] = freeModelsFrom([{ id: "a", isFree: true, context_length: "big" }])
		expect(model.context_length).toBe(0)
	})

	it("does not treat a truthy non-boolean as free", () => {
		expect(freeModelsFrom([{ id: "a", isFree: "true" }])).toEqual([])
		expect(freeModelsFrom([{ id: "a", isFree: 1 }])).toEqual([])
	})

	it("returns nothing for an empty catalogue", () => {
		expect(freeModelsFrom([])).toEqual([])
	})

	it("always marks a returned model free", () => {
		const [model] = freeModelsFrom([{ id: "a", isFree: true }])
		expect(model.isFree).toBe(true)
	})
})
