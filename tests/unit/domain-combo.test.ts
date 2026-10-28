import { describe, expect, it } from "vitest"
import {
	buildComboIndex,
	buildStudioTargetMap,
	describeComboCycle,
	findComboCycle,
	isValidComboName,
	normalizeMembers,
	readContextWindow,
	studioReachesCombo,
} from "../../apps/api/src/domain/combo.ts"

describe("combo name rules", () => {
	it("accepts letters, digits, dash, underscore and dot", () => {
		for (const name of ["mix", "my-combo", "a_b.c", "Camel123"]) {
			expect(isValidComboName(name), name).toBe(true)
		}
	})

	it("rejects a slash, a space and a non-string", () => {
		for (const name of ["openai/mix", "my combo", "", null, undefined, 42]) {
			expect(isValidComboName(name), String(name)).toBe(false)
		}
	})
})

describe("readContextWindow", () => {
	it("keeps a positive value", () => {
		expect(readContextWindow(200_000)).toBe(200_000)
	})

	it("floors a fraction", () => {
		expect(readContextWindow(1024.9)).toBe(1024)
	})

	it("collapses junk to auto", () => {
		for (const value of [undefined, null, "", "abc", 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(readContextWindow(value), String(value)).toBe(0)
		}
	})

	it("clamps above the ceiling instead of trusting the caller", () => {
		expect(readContextWindow(1e12)).toBe(100_000_000)
	})
})

describe("normalizeMembers", () => {
	it("trims, coerces and drops empties", () => {
		expect(normalizeMembers([" a ", null, "", 7, "b"])).toEqual(["a", "7", "b"])
	})

	it("returns empty for a non-array", () => {
		expect(normalizeMembers(undefined)).toEqual([])
		expect(normalizeMembers("nope")).toEqual([])
	})
})

describe("cycle detection", () => {
	// studio "workhorse" targets combo "mix"; combo "mix" lists "workhorse".
	const graph = {
		combos: buildComboIndex([
			{ name: "mix", models: ["workhorse"] },
			{ name: "safe", models: ["openai/gpt-4o"] },
		]),
		studioTargets: buildStudioTargetMap([
			{ callName: "workhorse", targetModel: "mix" },
			{ callName: "leaf", targetModel: "openai/gpt-4o" },
		]),
	}

	it("reports the chain when a member routes back into the combo", () => {
		expect(findComboCycle({ comboName: "mix", members: ["workhorse"], graph })).toEqual([
			"workhorse",
			"mix",
		])
	})

	it("passes a combo whose members are provider leaves", () => {
		expect(findComboCycle({ comboName: "safe", members: ["openai/gpt-4o"], graph })).toBeNull()
	})

	it("detects a studio resolving to the combo directly", () => {
		expect(studioReachesCombo({ studioName: "workhorse", comboName: "mix", graph })).toEqual([
			"workhorse",
			"mix",
		])
	})

	it("does not report a leaf studio", () => {
		expect(studioReachesCombo({ studioName: "leaf", comboName: "mix", graph })).toBeNull()
	})

	it("terminates on a self-referential combo instead of looping", () => {
		const cyclic = {
			combos: buildComboIndex([
				{ name: "a", models: ["b"] },
				{ name: "b", models: ["a"] },
			]),
			studioTargets: new Map<string, string>(),
		}
		expect(studioReachesCombo({ studioName: "a", comboName: "nowhere", graph: cyclic })).toBeNull()
	})

	it("finds a cycle through a nested combo", () => {
		const nested = {
			combos: buildComboIndex([
				{ name: "outer", models: ["inner"] },
				{ name: "inner", models: ["proxy"] },
			]),
			studioTargets: buildStudioTargetMap([{ callName: "proxy", targetModel: "outer" }]),
		}
		// The chain names every hop, including the nested combo it went through,
		// because that is what the user has to edit to break the loop.
		expect(findComboCycle({ comboName: "outer", members: ["inner"], graph: nested })).toEqual([
			"inner",
			"proxy",
			"outer",
		])
	})

	it("returns null when no member can close the loop", () => {
		expect(findComboCycle({ comboName: "absent", members: ["leaf"], graph })).toBeNull()
	})
})

describe("describeComboCycle", () => {
	it("names the whole chain so the user can see the loop", () => {
		expect(describeComboCycle(["a", "b"])).toBe(
			"That model routes back into this combo (a -> b). Pick a different member.",
		)
	})

	it("is silent for no chain", () => {
		expect(describeComboCycle(null)).toBe("")
		expect(describeComboCycle([])).toBe("")
	})
})
