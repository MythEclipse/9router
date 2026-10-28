import { beforeEach, describe, expect, it, vi } from "vitest"

// Copy Full: duplicating a combo must leave the original untouched, land on the
// first free "<name>-N" name, and carry the models plus the per-combo routing
// strategy (which lives in settings, keyed by combo name).
const fx = vi.hoisted(() => ({
	combos: [] as Array<Record<string, unknown>>,
	settings: { comboStrategies: {} as Record<string, unknown> },
	seq: 0,
}))

vi.mock("@/lib/localDb", () => ({
	getCombos: async () => fx.combos,
	getComboById: async (id: string) => fx.combos.find((c) => c.id === id) || null,
	createCombo: async (data: Record<string, unknown>) => {
		const combo = { id: `new-${++fx.seq}`, ...data }
		fx.combos.push(combo)
		return combo
	},
	getSettings: async () => fx.settings,
	updateSettings: async (updates: Record<string, unknown>) => {
		fx.settings = { ...fx.settings, ...updates } as typeof fx.settings
		return fx.settings
	},
}))

const { POST } = await import("../../src/app/api/combos/[id]/duplicate/route.js")
const { nextCopyName } = await import("../../src/shared/utils/comboCopyName.js")

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
