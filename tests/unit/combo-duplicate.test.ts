import { beforeEach, describe, expect, it, vi } from "vitest"

// Copy Full: duplicating a combo must leave the original untouched, land on the
// first free "<name>-N" name, and carry the models plus the per-combo routing
// strategy (which lives in settings, keyed by combo name).
const fx = vi.hoisted(() => ({
	combos: [] as Array<Record<string, unknown>>,
	settings: { comboStrategies: {} as Record<string, unknown> },
	seq: 0,
}))

// The route delegates to a use-case, so the fixture stands in for the service
// rather than the old `@/lib/localDb` accessors. A full module mock, without
// `importOriginal`: the real one opens a database, which Vitest (running on
// Node) cannot do.
// Mirrors the shape `toResponse` maps to a 404, without importing the real
// error module (it lives in `apps/api`, which pulls in the db client).
class ComboNotFoundError extends Error {
	readonly code = "NOT_FOUND"
	constructor(id: string) {
		super(`Combo not found: ${id}`)
	}
}

vi.mock("@/lib/useCases", () => ({
	getUseCases: () => ({
		duplicateCombo: async (id: string) => {
			const { nextCopyName } = await import("../../apps/web/src/shared/utils/comboCopyName.js")
			const source = fx.combos.find((c) => c.id === id)
			if (!source) throw new ComboNotFoundError(id)
			const copy = {
				id: `new-${++fx.seq}`,
				...source,
				name: nextCopyName(
					String(source.name),
					fx.combos.map((c) => String(c.name)),
				),
			}
			fx.combos.push(copy)
			const strategies = fx.settings.comboStrategies as Record<string, unknown>
			if (strategies[String(source.name)]) {
				strategies[copy.name] = structuredClone(strategies[String(source.name)])
			}
			return copy
		},
	}),
}))

// Static imports, not top-level `await import()`: the dynamic form is executed
// by Node's ESM loader before Vite's plugin pipeline sees it, so the stubbed
// `bun:sqlite` never gets substituted and the whole file fails to collect.
import { POST } from "../../apps/web/src/app/api/combos/[id]/duplicate/route.js"
import { nextCopyName } from "../../apps/web/src/shared/utils/comboCopyName.js"

const post = (id: string) => POST({}, { params: Promise.resolve({ id }) })

beforeEach(() => {
	fx.seq = 0
	fx.combos = [
		{
			id: "c1",
			name: "smart",
			kind: "llm",
			models: ["oc/a-free", "cc/b"],
			contextWindow: 200000,
		},
	]
	fx.settings = {
		comboStrategies: {
			smart: { fallbackStrategy: "smart", routerModel: "oc/judge", sessionSticky: false },
		},
	}
})

describe("nextCopyName", () => {
	it("starts at -1 and never reuses a taken suffix", () => {
		expect(nextCopyName("smart", [])).toBe("smart-1")
		expect(nextCopyName("smart", ["smart", "smart-1"])).toBe("smart-2")
		expect(nextCopyName("smart", ["smart", "smart-1", "smart-3"])).toBe("smart-2")
	})

	it("does not treat a numeric name tail as a copy suffix", () => {
		expect(nextCopyName("claude-sonnet-4-5", [])).toBe("claude-sonnet-4-5-1")
	})
})

describe("POST /api/combos/[id]/duplicate", () => {
	it("copies models, kind and context window into the next free name", async () => {
		const res = await post("c1")
		expect(res.status).toBe(201)
		const created = await res.json()
		expect(created.name).toBe("smart-1")
		expect(created.models).toEqual(["oc/a-free", "cc/b"])
		expect(created.kind).toBe("llm")
		expect(created.contextWindow).toBe(200000)
		// The source combo is untouched.
		expect(fx.combos.find((c) => c.id === "c1")).toMatchObject({
			name: "smart",
			models: ["oc/a-free", "cc/b"],
		})
	})

	it("walks the suffix forward on repeated copies", async () => {
		await post("c1")
		const second = await (await post("c1")).json()
		expect(second.name).toBe("smart-2")
	})

	it("carries the routing strategy over to the copy without aliasing it", async () => {
		await post("c1")
		const strategies = fx.settings.comboStrategies as Record<string, Record<string, unknown>>
		expect(strategies["smart-1"]).toEqual(strategies.smart)
		expect(strategies["smart-1"]).not.toBe(strategies.smart)
	})

	it("404s on an unknown combo", async () => {
		expect((await post("missing")).status).toBe(404)
	})
})
