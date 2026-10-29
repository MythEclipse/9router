// Tests for apps/api/src/application/providers/suggest-models.ts — reading a
// provider's own catalogue, with the stored-copy and timeout branches.
//
// No existing test file covers this use-case; the fetch, filter choice and
// whole-request ceiling lived inline in
// apps/web/src/app/api/providers/suggested-models/route.ts.
//
// User instruction, verbatim: "lanjut kenapa malah berhenti".

import { describe, expect, it, vi } from "vitest"
import {
	makeSuggestModels,
	type SyncedCatalogue,
} from "../../apps/api/src/application/providers/suggest-models.ts"
import type { CatalogueFilters } from "../../apps/api/src/domain/model-catalogue.ts"

const catalogue: CatalogueFilters = {
	filters: {
		openai: (models) =>
			(Array.isArray(models) ? models : [])
				.filter((m) => typeof (m as { id?: unknown }).id === "string")
				.map((m) => ({
					id: (m as { id: string }).id,
					name: (m as { id: string }).id,
					contextLength: (m as { context_length?: number }).context_length,
				})),
	},
	fallbacks: { openai: [{ id: "built-in", name: "built-in" }] },
}

const live = { data: [{ id: "live-model" }] }

function harness(
	options: {
		fetch?: (url: string, type: string) => Promise<unknown>
		synced?: SyncedCatalogue | null
		syncable?: { id: string } | null
		timeoutMs?: number
	} = {},
) {
	const refreshSynced = vi.fn()
	const armSyncer = vi.fn()
	const useCase = makeSuggestModels({
		catalogue,
		findSyncable: () => (options.syncable === undefined ? { id: "entry-1" } : options.syncable),
		readSynced: async () => options.synced ?? null,
		refreshSynced,
		fetchCatalogue: options.fetch ?? (async () => live),
		armSyncer,
		timeoutMs: options.timeoutMs ?? 12_000,
	})
	return { useCase, refreshSynced, armSyncer }
}

describe("validation", () => {
	it("refuses a missing url or type", async () => {
		const { useCase } = harness()
		await expect(useCase.run({ url: "https://x", type: null })).rejects.toThrow("Missing url or type")
		await expect(useCase.run({ url: null, type: "openai" })).rejects.toThrow("Missing url or type")
	})

	it("refuses an unknown filter type rather than guessing one", async () => {
		const { useCase } = harness()
		await expect(useCase.run({ url: "https://x", type: "gemini" })).rejects.toThrow(
			"Unknown filter type",
		)
	})
})

describe("live catalogue", () => {
	it("answers the filtered live list", async () => {
		const { useCase } = harness({
			fetch: async () => ({ data: [{ id: "a" }, { id: "b" }, { notAnId: true }] }),
		})
		const answer = await useCase.run({ url: "https://x", type: "openai" })
		expect(answer.source).toBe("live")
		expect(answer.stale).toBe(false)
		expect(answer.data.map((m) => m.id)).toEqual(["a", "b"])
	})

	it("reads a bare array body as well as a wrapped one", async () => {
		const { useCase } = harness({ fetch: async () => [{ id: "bare" }] })
		expect((await useCase.run({ url: "https://x", type: "openai" })).data[0].id).toBe("bare")
	})

	it("reads a { models: [...] } body", async () => {
		const { useCase } = harness({ fetch: async () => ({ models: [{ id: "m" }] }) })
		expect((await useCase.run({ url: "https://x", type: "openai" })).data[0].id).toBe("m")
	})

	it("refreshes the stored copy only after a non-empty live answer", async () => {
		const { useCase, refreshSynced } = harness({ fetch: async () => ({ data: [{ id: "a" }] }) })
		await useCase.run({ url: "https://x", type: "openai" })
		expect(refreshSynced).toHaveBeenCalledWith("entry-1")
	})

	it("does not refresh the stored copy from an empty answer", async () => {
		const { useCase, refreshSynced } = harness({ fetch: async () => ({ data: [] }) })
		await useCase.run({ url: "https://x", type: "openai" })
		expect(refreshSynced).not.toHaveBeenCalled()
	})

	it("stores nothing for a url the registry does not know", async () => {
		const { useCase, refreshSynced } = harness({
			fetch: async () => ({ data: [{ id: "a" }] }),
			syncable: null,
		})
		expect((await useCase.run({ url: "https://x", type: "openai" })).source).toBe("live")
		expect(refreshSynced).not.toHaveBeenCalled()
	})
})

describe("degradation", () => {
	const synced: SyncedCatalogue = {
		data: [{ id: "synced-model", name: "synced-model" }],
		syncedAt: "2026-10-01T00:00:00Z",
	}

	it("prefers the stored copy when the fetch throws", async () => {
		const { useCase } = harness({
			fetch: async () => {
				throw new Error("ECONNREFUSED")
			},
			synced,
		})
		const answer = await useCase.run({ url: "https://x", type: "openai" })
		expect(answer.source).toBe("synced")
		expect(answer.stale).toBe(true)
		expect(answer.data).toEqual(synced.data)
		expect(answer.syncedAt).toBe("2026-10-01T00:00:00Z")
	})

	it("falls to the built-in table when the fetch throws and nothing was stored", async () => {
		const { useCase } = harness({
			fetch: async () => {
				throw new Error("ECONNREFUSED")
			},
			synced: null,
		})
		const answer = await useCase.run({ url: "https://x", type: "openai" })
		expect(answer.source).toBe("fallback")
		expect(answer.stale).toBe(false)
		expect(answer.data).toEqual([{ id: "built-in", name: "built-in" }])
	})

	it("treats an empty live list as degradation", async () => {
		const { useCase } = harness({ fetch: async () => ({ data: [] }), synced })
		expect((await useCase.run({ url: "https://x", type: "openai" })).source).toBe("synced")
	})

	it("survives a store that throws while reading the copy", async () => {
		const useCase = makeSuggestModels({
			catalogue,
			findSyncable: () => ({ id: "entry-1" }),
			readSynced: async () => {
				throw new Error("db locked")
			},
			refreshSynced: () => {},
			fetchCatalogue: async () => live,
			armSyncer: () => {},
			timeoutMs: 12_000,
		})
		expect((await useCase.run({ url: "https://x", type: "openai" })).source).toBe("live")
	})
})

describe("the whole-request ceiling", () => {
	it("answers from the built-in table when the fetch outlasts the budget", async () => {
		// The branch that has already proved I/O can stall must touch none.
		const { useCase } = harness({
			fetch: () => new Promise(() => {}),
			timeoutMs: 10,
		})
		const answer = await useCase.run({ url: "https://x", type: "openai" })
		expect(answer.data).toEqual([{ id: "built-in", name: "built-in" }])
		expect(answer.source).toBe("fallback")
	})

	it("still surfaces a caller's refusal instead of masking it as a timeout", async () => {
		const { useCase } = harness({ timeoutMs: 12_000 })
		await expect(useCase.run({ url: null, type: "openai" })).rejects.toMatchObject({
			code: "VALIDATION",
		})
	})
})

describe("the syncer", () => {
	it("arms the background syncer once per process, not per request", async () => {
		// The route is the earliest reliable hook on installs that never open the
		// provider page, so it arms the syncer once and never again.
		const { useCase, armSyncer } = harness()
		await useCase.run({ url: "https://x", type: "openai" })
		await useCase.run({ url: "https://x", type: "openai" })
		expect(armSyncer).toHaveBeenCalledOnce()
	})

	it("does not fail the request when arming the syncer throws", async () => {
		const useCase = makeSuggestModels({
			catalogue,
			findSyncable: () => null,
			readSynced: async () => null,
			refreshSynced: () => {},
			fetchCatalogue: async () => live,
			armSyncer: () => {
				throw new Error("timer exploded")
			},
			timeoutMs: 12_000,
		})
		expect((await useCase.run({ url: "https://x", type: "openai" })).source).toBe("live")
	})
})
