/**
 * Replay export: the three ways a generated fixture lies.
 *
 * A case with no expected translation, a fixture that diffs on every regeneration, and a
 * fixture that commits a credential. Each is asserted below against the rule that prevents it.
 */

import { makeReplay, type ReplayPorts } from "9router-api/application/requests/replay"
import {
	type CapturedDetail,
	caseName,
	replayCaseOf,
	replayCasesOf,
	stableValue,
	vitestSource,
} from "9router-api/domain/replay-case"
import { describe, expect, it } from "vitest"

const capture = (over: Partial<CapturedDetail> = {}): CapturedDetail => ({
	id: "req_1",
	timestamp: 1_700_000_000_000,
	provider: "claude",
	model: "claude-3-5-sonnet",
	request: { model: "claude-3-5-sonnet", messages: [{ role: "user", content: "hi" }] },
	providerRequest: { model: "claude-3-5-sonnet", system: "", messages: [] },
	...over,
})

describe("stableValue", () => {
	it("redacts a credential by field name, at any depth", () => {
		const value = stableValue({
			headers: { Authorization: "Bearer sk-live", "x-api-key": "abc" },
			nested: { apiKey: "k" },
		}) as Record<string, Record<string, unknown>>

		expect(value.headers?.Authorization).toBe("[REDACTED]")
		expect(value.headers?.["x-api-key"]).toBe("[REDACTED]")
		expect(value.nested?.apiKey).toBe("[REDACTED]")
	})

	it("replaces volatile scalars so a regeneration produces no diff", () => {
		const value = stableValue({
			id: "req_abc",
			created: 1_700_000_000_000,
			createdAt: "2026-10-31T00:00:00Z",
			keep: "this",
		}) as Record<string, unknown>

		expect(value.id).toBe("<id>")
		expect(value.created).toBe(0)
		expect(value.createdAt).toBe("<createdAt>")
		expect(value.keep).toBe("this")
	})

	it("keeps a boolean that happens to be named like a timestamp", () => {
		// `created: false` is data, not a timestamp; zeroing it would change the case.
		expect((stableValue({ created: false }) as Record<string, unknown>).created).toBe(false)
	})

	it("walks arrays without reordering them", () => {
		const value = stableValue([{ id: "a" }, { id: "b" }]) as Array<Record<string, unknown>>

		expect(value.map((entry) => entry.id)).toEqual(["<id>", "<id>"])
	})
})

describe("replayCaseOf", () => {
	it("builds a case from a capture with an expected translation", () => {
		const built = replayCaseOf(capture())

		expect(built?.provider).toBe("claude")
		expect(built?.request).toBeDefined()
		expect(built?.providerRequest).toBeDefined()
	})

	it("refuses a capture with no provider request, which proves nothing", () => {
		expect(replayCaseOf(capture({ providerRequest: undefined }))).toBeNull()
		expect(replayCaseOf(capture({ request: undefined }))).toBeNull()
	})

	it("prefers the resolved model, which is what the provider was actually asked for", () => {
		const built = replayCaseOf(capture({ resolvedModel: "claude-3-5-haiku" }))

		expect(built?.model).toBe("claude-3-5-haiku")
	})

	it("keeps the unusable captures out of a batch and counts them as skipped", () => {
		const cases = replayCasesOf([capture(), capture({ providerRequest: null })])

		expect(cases).toHaveLength(1)
	})
})

describe("caseName", () => {
	it("names the case after the provider and model, and stays unique by index", () => {
		expect(caseName(capture(), 2)).toBe("claude claude-3-5-sonnet #3")
	})

	it("strips characters that would break a test name", () => {
		expect(caseName(capture({ model: "gpt/4o mini" }), 0)).toBe("claude gpt-4o-mini #1")
	})
})

describe("vitestSource", () => {
	it("emits a runnable file that asserts the recorded pair", () => {
		const source = vitestSource([replayCaseOf(capture())!])

		expect(source).toContain('import { describe, expect, it } from "vitest"')
		expect(source).toContain("claude claude-3-5-sonnet #1")
		expect(source).toContain("toEqual(expected)")
	})

	it("refuses to emit a file with no cases, which would pass by doing nothing", () => {
		expect(() => vitestSource([])).toThrow(/no replayable cases/)
	})
})

function ports(details: CapturedDetail[]) {
	const byId = new Map(details.map((detail) => [String(detail.id), detail]))
	const port: ReplayPorts = {
		byId: async (id) => byId.get(id) ?? null,
		recent: async (limit) => details.slice(0, limit),
	}
	return port
}

describe("makeReplay", () => {
	it("exports the requested ids and reports the one that aged out", async () => {
		const useCase = makeReplay(ports([capture()]))
		const suite = await useCase.fromIds(["req_1", "req_gone"])

		expect(suite.cases).toHaveLength(1)
		expect(suite.skipped).toBe(1)
	})

	it("counts an id that aged out as skipped when the others survive", async () => {
		const suite = await makeReplay(ports([capture({ id: "req_1" })])).fromIds(["req_1", "req_gone"])

		expect(suite.cases).toHaveLength(1)
		expect(suite.skipped).toBe(1)
	})

	it("refuses to answer a suite when every requested id aged out", async () => {
		// A file with no cases passes by asserting nothing, which is worse than an error.
		await expect(makeReplay(ports([capture({ id: "req_2" })])).fromIds(["req_1"])).rejects.toThrow(
			/no replayable cases/,
		)
	})

	it("clamps the recent limit so the file stays reviewable", async () => {
		const many = Array.from({ length: 80 }, (_, index) => capture({ id: `req_${index}` }))
		const suite = await makeReplay(ports(many)).fromRecent(500)

		expect(suite.cases.length).toBeLessThanOrEqual(50)
	})

	it("answers a sensible default when the limit is junk", async () => {
		const many = Array.from({ length: 20 }, (_, index) => capture({ id: `req_${index}` }))
		const suite = await makeReplay(ports(many)).fromRecent(Number.NaN)

		expect(suite.cases).toHaveLength(10)
	})
})
