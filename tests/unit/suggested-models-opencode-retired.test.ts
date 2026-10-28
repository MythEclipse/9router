import { describe, expect, it } from "vitest"

import {
	FILTERS,
	isFreeOpencodeModel,
	onlyFree,
} from "@/app/api/providers/suggested-models/filters.js"

// The picker behind dashboard/providers builds its chips from this filter, so a
// retired upstream id that the catalogue still echoes must not reach the UI.
// muse-spark-1.2/1.3 exist upstream without the -contributor-free suffix but
// answer 401 Missing API key: paid ids that must never look free.
const RETIRED_FREE_IDS = [
	"muse-spark-1.2-contributor-free",
	"muse-spark-1.3-contributor-free",
	"nemotron-3-ultra-free",
	"minimax-m3.1-flash-free",
]

function catalogue(ids: string[]) {
	return ids.map((id) => ({ id, name: id }))
}

describe("opencode-free suggested models", () => {
	it("drops every retired free id the catalogue still echoes", () => {
		const models = FILTERS["opencode-free"](
			catalogue([...RETIRED_FREE_IDS, "deepseek-v4.1-flash-free"]),
		)
		expect(models.map((model: { id: string }) => model.id)).toEqual(["deepseek-v4.1-flash-free"])
	})

	it("keeps ids it does not know to be dead", () => {
		const models = FILTERS["opencode-free"](catalogue(["big-pickle", "nemotron-3.5-lightning-free"]))
		expect(models.map((model: { id: string }) => model.id).sort()).toEqual([
			"big-pickle",
			"nemotron-3.5-lightning-free",
		])
	})

	it("never labels a retired id as free, even outside the picker filter", () => {
		for (const id of RETIRED_FREE_IDS) {
			expect(isFreeOpencodeModel({ id })).toBe(false)
		}
	})

	it("survives an upstream catalogue that is not a list", () => {
		expect(FILTERS["opencode-free"](null)).toEqual([])
		expect(FILTERS["opencode-free"](undefined)).toEqual([])
		expect(onlyFree(null)).toEqual([])
	})
})
