import { describe, expect, it } from "vitest"
import { makeFreeModels } from "../../apps/api/src/application/providers/list-free-models.ts"
import { makeOverrides } from "../../apps/api/src/application/providers/manage-overrides.ts"
import type { FreeModel } from "../../apps/api/src/domain/free-model-cache.ts"
import type { ProviderOverride } from "../../apps/api/src/domain/provider-override.ts"

const HOUR = 60 * 60 * 1000

describe("free models", () => {
	function harness(
		options: {
			readonly entry?: { value: FreeModel[]; storedAt: number } | null
			readonly fetch?: () => Promise<readonly { id?: unknown; isFree?: unknown }[]>
			readonly now?: number
		} = {},
	) {
		let stored = options.entry ?? null
		let clock = options.now ?? 0
		const state = { writes: 0, fetches: 0 }
		const useCase = makeFreeModels({
			fetchCatalogue: async () => {
				state.fetches++
				return options.fetch ? options.fetch() : [{ id: "m", name: "M", isFree: true }]
			},
			cache: {
				read: () => stored,
				write: (entry) => {
					state.writes++
					stored = entry
				},
			},
			now: () => clock,
		})
		return {
			useCase,
			state,
			advance: (ms: number) => {
				clock += ms
			},
			stored: () => stored,
		}
	}

	it("fetches on a cold cache and stores the result", async () => {
		const h = harness()
		const result = await h.useCase.list()
		expect(result.kind).toBe("fresh")
		expect(h.state.fetches).toBe(1)
		expect(h.state.writes).toBe(1)
	})

	it("serves a fresh entry without calling upstream", async () => {
		const h = harness({
			entry: { value: [{ id: "c", name: "C", isFree: true, context_length: 0 }], storedAt: 0 },
			now: HOUR - 1,
		})
		const result = await h.useCase.list()
		expect(result).toEqual({
			kind: "cached",
			models: [{ id: "c", name: "C", isFree: true, context_length: 0 }],
		})
		expect(h.state.fetches).toBe(0)
	})

	it("refetches once the entry goes stale", async () => {
		const h = harness({
			entry: { value: [{ id: "c", name: "C", isFree: true, context_length: 0 }], storedAt: 0 },
			now: HOUR,
		})
		const result = await h.useCase.list()
		expect(result.kind).toBe("fresh")
		expect(h.state.fetches).toBe(1)
	})

	it("serves the stale entry with a warning when the fetch fails", async () => {
		const h = harness({
			entry: { value: [{ id: "c", name: "C", isFree: true, context_length: 0 }], storedAt: 0 },
			now: HOUR,
			fetch: async () => {
				throw new Error("upstream 503")
			},
		})
		const result = await h.useCase.list()
		expect(result).toEqual({
			kind: "stale",
			models: [{ id: "c", name: "C", isFree: true, context_length: 0 }],
			warning: "upstream 503",
		})
	})

	it("reports a failure when there is nothing to serve", async () => {
		const h = harness({
			fetch: async () => {
				throw new Error("upstream 503")
			},
		})
		expect(await h.useCase.list()).toEqual({ kind: "failed", message: "upstream 503" })
	})

	it("does not serve an entry past the stale ceiling", async () => {
		const h = harness({
			entry: { value: [{ id: "c", name: "C", isFree: true, context_length: 0 }], storedAt: 0 },
			now: 365 * 24 * HOUR,
			fetch: async () => {
				throw new Error("upstream 503")
			},
		})
		expect((await h.useCase.list()).kind).toBe("failed")
	})

	it("reports a non-Error throw as a message", async () => {
		const h = harness({
			fetch: async () => {
				throw "plain string"
			},
		})
		expect(await h.useCase.list()).toEqual({ kind: "failed", message: "plain string" })
	})
})

describe("provider overrides", () => {
	function harness(seed: Record<string, ProviderOverride> = {}) {
		let overrides = seed
		const writes: Record<string, ProviderOverride>[] = []
		const useCase = makeOverrides({
			read: async () => overrides,
			write: async (next) => {
				writes.push(next)
				overrides = next
			},
			resolveAlias: (id) => (id === "gcli" ? "gemini-cli" : id),
			builtinHeaders: (canonical): Record<string, string> =>
				canonical === "gemini-cli" ? { "x-builtin": "1" } : {},
		})
		return { useCase, writes, current: () => overrides }
	}

	it("returns an empty override and the builtin headers", async () => {
		const h = harness()
		expect(await h.useCase.get("gcli")).toEqual({
			headers: {},
			builtinHeaders: { "x-builtin": "1" },
		})
	})

	it("resolves an alias before reading", async () => {
		const h = harness({ "gemini-cli": { headers: { "x-a": "1" } } })
		const result = await h.useCase.get("gcli")
		expect(result.headers).toEqual({ "x-a": "1" })
	})

	it("writes under the canonical id, not the alias", async () => {
		const h = harness()
		await h.useCase.set("gcli", { headers: { "x-a": "1" } })
		expect(h.current()).toEqual({ "gemini-cli": { headers: { "x-a": "1" } } })
	})

	it("refuses an invalid header with a validation message", async () => {
		const h = harness()
		await expect(h.useCase.set("gemini", { headers: { host: "evil" } })).rejects.toThrow(
			"Header host cannot be overridden",
		)
		expect(h.writes).toHaveLength(0)
	})

	it("clears on an empty payload and removes the key", async () => {
		const h = harness({ gemini: { headers: { "x-a": "1" } } })
		await h.useCase.set("gemini", {})
		expect(h.current()).toEqual({})
	})

	it("leaves another provider's override untouched", async () => {
		const h = harness({ openai: { headers: { "x-o": "1" } } })
		await h.useCase.set("gemini", { headers: { "x-g": "1" } })
		expect(h.current()).toEqual({
			openai: { headers: { "x-o": "1" } },
			gemini: { headers: { "x-g": "1" } },
		})
	})

	it("returns the stored headers after a write", async () => {
		const h = harness()
		expect(await h.useCase.set("gemini", { headers: { "x-a": "1" } })).toEqual({
			headers: { "x-a": "1" },
		})
	})
})
