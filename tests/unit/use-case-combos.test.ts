import { describe, expect, it } from "vitest"
import {
	makeCreateCombo,
	makeDeleteCombo,
	makeListCombos,
	makeUpdateCombo,
} from "../../apps/api/src/application/combos/manage-combos.ts"
import type {
	ComboInput,
	ComboPort,
	ComboRotationPort,
	ComboView,
	StudioTarget,
	StudioTargetPort,
} from "../../apps/api/src/application/dependencies.ts"

/** In-memory ComboPort so the rules can be exercised without a database. */
function fakeCombos(seed: ComboView[] = []) {
	const rows = new Map(seed.map((c) => [c.id, { ...c }]))
	let nextId = rows.size + 1
	const port: ComboPort = {
		async list() {
			return [...rows.values()]
		},
		async findById(id) {
			return rows.get(id) ?? null
		},
		async findByName(name) {
			return [...rows.values()].find((c) => c.name === name) ?? null
		},
		async create(input: ComboInput) {
			const combo: ComboView = {
				id: `c${nextId++}`,
				name: input.name,
				models: input.models,
				kind: input.kind ?? null,
				contextWindow: input.contextWindow ?? 0,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			}
			rows.set(combo.id, combo)
			return combo
		},
		async update(id, input) {
			const current = rows.get(id)
			if (!current) return null
			const next = { ...current, ...input }
			rows.set(id, next)
			return next
		},
		async remove(id) {
			return rows.delete(id)
		},
	}
	return { port, rows }
}

function fakeStudios(targets: StudioTarget[] = []): StudioTargetPort {
	return {
		async list() {
			return targets
		},
	}
}

function fakeRotation() {
	const reset: string[] = []
	const port: ComboRotationPort = { reset: (name) => void reset.push(name) }
	return { port, reset }
}

function deps(seed: ComboView[] = [], studios: StudioTarget[] = []) {
	const combos = fakeCombos(seed)
	const rotation = fakeRotation()
	return {
		combos,
		rotation,
		deps: { combos: combos.port, studios: fakeStudios(studios), rotation: rotation.port },
	}
}

describe("createCombo", () => {
	it("creates a combo and reads an absent context window as auto", async () => {
		const { deps: d } = deps()
		const created = await makeCreateCombo(d)({ name: "mix", models: ["openai/gpt-4o"] })
		expect(created.name).toBe("mix")
		expect(created.contextWindow).toBe(0)
	})

	it("rejects a missing name", async () => {
		const { deps: d } = deps()
		await expect(makeCreateCombo(d)({ name: "" })).rejects.toThrow("Name is required")
	})

	it("rejects a name with a slash before touching storage", async () => {
		const { deps: d, combos } = deps()
		await expect(makeCreateCombo(d)({ name: "openai/mix" })).rejects.toThrow(
			"Name can only contain letters, numbers, -, _ and .",
		)
		expect(combos.rows.size).toBe(0)
	})

	it("rejects a duplicate name", async () => {
		const { deps: d } = deps([
			{
				id: "c1",
				name: "mix",
				models: [],
				kind: null,
				contextWindow: 0,
				createdAt: "",
				updatedAt: "",
			},
		])
		await expect(makeCreateCombo(d)({ name: "mix" })).rejects.toThrow("Combo name already exists")
	})

	it("clamps an absurd context window", async () => {
		const { deps: d } = deps()
		const created = await makeCreateCombo(d)({ name: "big", contextWindow: 1e15 })
		expect(created.contextWindow).toBe(100_000_000)
	})

	it("refuses a member studio that routes back into the new combo", async () => {
		const { deps: d } = deps([], [{ callName: "workhorse", targetModel: "mix" }])
		await expect(makeCreateCombo(d)({ name: "mix", models: ["workhorse"] })).rejects.toThrow(
			/routes back into this combo/,
		)
	})

	it("allows a member studio that resolves elsewhere", async () => {
		const { deps: d } = deps([], [{ callName: "leaf", targetModel: "openai/gpt-4o" }])
		const created = await makeCreateCombo(d)({ name: "mix", models: ["leaf"] })
		expect(created.models).toEqual(["leaf"])
	})
})

describe("updateCombo", () => {
	const seed = () => [
		{
			id: "c1",
			name: "mix",
			models: ["openai/gpt-4o"],
			kind: null,
			contextWindow: 0,
			createdAt: "",
			updatedAt: "",
		},
	]

	it("invalidates rotation for the old name on rename", async () => {
		const { deps: d, rotation } = deps(seed())
		const updated = await makeUpdateCombo(d)("c1", { name: "renamed" })
		expect(updated.name).toBe("renamed")
		expect(rotation.reset).toContain("mix")
	})

	it("does not treat a combo's own name as a clash", async () => {
		const { deps: d } = deps(seed())
		await expect(makeUpdateCombo(d)("c1", { name: "mix" })).resolves.toMatchObject({ name: "mix" })
	})

	it("rejects a name already used by another combo", async () => {
		const { deps: d } = deps([
			...seed(),
			{
				id: "c2",
				name: "other",
				models: [],
				kind: null,
				contextWindow: 0,
				createdAt: "",
				updatedAt: "",
			},
		])
		await expect(makeUpdateCombo(d)("c1", { name: "other" })).rejects.toThrow(
			"Combo name already exists",
		)
	})

	it("reports a missing combo", async () => {
		const { deps: d } = deps(seed())
		await expect(makeUpdateCombo(d)("absent", { name: "x" })).rejects.toThrow("Combo not found")
	})

	it("normalizes members before storing them", async () => {
		const { deps: d } = deps(seed())
		const updated = await makeUpdateCombo(d)("c1", { models: [" a ", "", "b"] })
		expect(updated.models).toEqual(["a", "b"])
	})
})

describe("deleteCombo", () => {
	it("removes the combo and invalidates its rotation", async () => {
		const {
			deps: d,
			rotation,
			combos,
		} = deps([
			{
				id: "c1",
				name: "mix",
				models: [],
				kind: null,
				contextWindow: 0,
				createdAt: "",
				updatedAt: "",
			},
		])
		await expect(makeDeleteCombo(d)("c1")).resolves.toEqual({ success: true })
		expect(combos.rows.size).toBe(0)
		expect(rotation.reset).toContain("mix")
	})

	it("reports a missing combo", async () => {
		const { deps: d } = deps()
		await expect(makeDeleteCombo(d)("absent")).rejects.toThrow("Combo not found")
	})
})

describe("listCombos", () => {
	it("returns rows under a combos key", async () => {
		const { deps: d } = deps([
			{
				id: "c1",
				name: "mix",
				models: [],
				kind: null,
				contextWindow: 0,
				createdAt: "",
				updatedAt: "",
			},
		])
		await expect(makeListCombos(d)()).resolves.toMatchObject({ combos: [{ name: "mix" }] })
	})
})
