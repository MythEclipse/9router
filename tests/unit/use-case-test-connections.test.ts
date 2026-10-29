// Tests for apps/api/src/application/providers/test-connections.ts — the batch
// loop: which connections it takes, one row per probe, and what one failure costs.
//
// No existing test file covers this use-case; the loop lived inline in
// apps/web/src/app/api/providers/test-batch/route.ts with no unit test.
//
// User instruction, verbatim: "lanjut kenapa malah berhenti".

import { describe, expect, it, vi } from "vitest"
import { makeTestConnections } from "../../apps/api/src/application/providers/test-connections.ts"
import type { ProbeOutcome } from "../../apps/api/src/domain/batch-result.ts"
import type { ProviderClassifiers } from "../../apps/api/src/domain/batch-selection.ts"

const classifiers: ProviderClassifiers = {
	isFree: (p) => p === "kiro",
	isOAuth: () => false,
	isApiKey: () => false,
	isCompatible: (p) => p.startsWith("openai-compatible-"),
}

const stored = [
	{ id: "1", provider: "kiro", name: "free one", authType: "oauth", isActive: true },
	{ id: "2", provider: "claude", email: "a@b.c", authType: "oauth", isActive: true },
	{ id: "3", provider: "openai", authType: "apikey", isActive: true },
	{ id: "4", provider: "claude", authType: "oauth", isActive: false },
]

function harness(
	options: {
		list?: (filter?: { isActive?: boolean }) => Promise<typeof stored>
		probe?: (id: string) => Promise<ProbeOutcome>
	} = {},
) {
	const probe = vi.fn(options.probe ?? (async () => ({ valid: true, latencyMs: 5 })))
	// The real store applies the filter; the mock does the same so the test is not
	// asserting against a store that ignores what it was asked for.
	const list = vi.fn(
		options.list ??
			(async (filter?: { isActive?: boolean }) =>
				filter?.isActive === undefined ? stored : stored.filter((c) => c.isActive === filter.isActive)),
	)
	const useCase = makeTestConnections({
		connections: {
			list,
			find: async () => null,
			create: async () => {
				throw new Error("unused")
			},
			update: async () => null,
			remove: async () => false,
		},
		classifiers,
		probe,
		now: () => "2026-10-29T00:00:00.000Z",
	})
	return { useCase, probe, list }
}

describe("mode validation", () => {
	it("refuses a missing mode", async () => {
		const { useCase, probe } = harness()
		await expect(useCase.run({ mode: "" })).rejects.toThrow("mode is required")
		expect(probe).not.toHaveBeenCalled()
	})

	it("refuses an unknown mode and names the accepted ones", async () => {
		const { useCase } = harness()
		await expect(useCase.run({ mode: "everything" })).rejects.toThrow(/Invalid mode/)
	})

	it("marks the refusal as a validation failure", async () => {
		const { useCase } = harness()
		await expect(useCase.run({ mode: "nope" })).rejects.toMatchObject({ code: "VALIDATION" })
	})
})

describe("selection", () => {
	it("only considers active connections", async () => {
		const { useCase, probe } = harness()
		const report = await useCase.run({ mode: "all" })
		expect(report.results.map((r) => r.connectionId)).toEqual(["1", "2", "3"])
		// The disabled claude connection must never be probed: reporting it red
		// after every batch would make the summary look worse than the fleet.
		expect(probe).not.toHaveBeenCalledWith("4")
	})

	it("asks the store for active connections rather than filtering itself", async () => {
		const { useCase, list } = harness()
		await useCase.run({ mode: "all" })
		expect(list).toHaveBeenCalledWith({ isActive: true })
	})

	it("narrows to one provider", async () => {
		const { useCase } = harness()
		const report = await useCase.run({ mode: "provider", providerId: "claude" })
		expect(report.results.map((r) => r.connectionId)).toEqual(["2"])
	})

	it("narrows to the free group", async () => {
		const { useCase } = harness()
		const report = await useCase.run({ mode: "free" })
		expect(report.results.map((r) => r.connectionId)).toEqual(["1"])
	})

	it("returns an empty run rather than an error when nothing matches", async () => {
		const { useCase, probe } = harness()
		const report = await useCase.run({ mode: "provider", providerId: "ghost" })
		expect(report.results).toEqual([])
		expect(report.summary).toEqual({ total: 0, passed: 0, failed: 0 })
		expect(probe).not.toHaveBeenCalled()
	})
})

describe("report shape", () => {
	it("echoes the mode and provider id so the panel can name the run", async () => {
		const { useCase } = harness()
		const report = await useCase.run({ mode: "provider", providerId: "claude" })
		expect(report.mode).toBe("provider")
		expect(report.providerId).toBe("claude")
	})

	it("reports a null provider id when none was given", async () => {
		const { useCase } = harness()
		expect((await useCase.run({ mode: "all" })).providerId).toBeNull()
	})

	it("stamps one testedAt for the run", async () => {
		const { useCase } = harness()
		expect((await useCase.run({ mode: "all" })).testedAt).toBe("2026-10-29T00:00:00.000Z")
	})

	it("labels a row by name, then email, then provider", async () => {
		const { useCase } = harness()
		const report = await useCase.run({ mode: "all" })
		expect(report.results.map((r) => r.connectionName)).toEqual(["free one", "a@b.c", "openai"])
	})

	it("counts passed and failed", async () => {
		const { useCase } = harness({
			probe: async (id) => ({ valid: id !== "2", error: id === "2" ? "HTTP 401" : null }),
		})
		const report = await useCase.run({ mode: "all" })
		expect(report.summary).toEqual({ total: 3, passed: 2, failed: 1 })
	})
})

describe("failure isolation", () => {
	it("turns a thrown probe into a failed row and keeps going", async () => {
		const seen: string[] = []
		const { useCase } = harness({
			probe: async (id) => {
				seen.push(id)
				if (id === "1") throw new Error("ECONNREFUSED")
				return { valid: true }
			},
		})
		const report = await useCase.run({ mode: "all" })

		expect(seen).toEqual(["1", "2", "3"])
		expect(report.results[0]).toMatchObject({
			connectionId: "1",
			valid: false,
			error: "ECONNREFUSED",
			latencyMs: 0,
		})
		expect(report.results[1].valid).toBe(true)
		expect(report.summary).toEqual({ total: 3, passed: 2, failed: 1 })
	})
})

describe("ordering", () => {
	it("probes one at a time, in the store's order", async () => {
		// Sequential on purpose: the probe refreshes OAuth tokens and writes them
		// back, so two probes of one provider must not race that write.
		let inFlight = 0
		let peak = 0
		const { useCase } = harness({
			probe: async () => {
				inFlight += 1
				peak = Math.max(peak, inFlight)
				await new Promise((resolve) => setTimeout(resolve, 1))
				inFlight -= 1
				return { valid: true }
			},
		})
		await useCase.run({ mode: "all" })
		expect(peak).toBe(1)
	})
})
