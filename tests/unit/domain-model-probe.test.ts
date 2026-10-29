import { describe, expect, it } from "vitest"
import {
	needsLiveModels,
	type ProbeTarget,
	probeAll,
	probeKindOf,
	probeRef,
	targetsFromLiveModels,
} from "../../apps/api/src/domain/model-probe.ts"

const targets = (...ids: string[]): ProbeTarget[] => ids.map((id) => ({ id }))

describe("probeKindOf", () => {
	it("prefers kind", () => {
		expect(probeKindOf({ id: "a", kind: "image", type: "llm" })).toBe("image")
	})

	it("falls back to type", () => {
		expect(probeKindOf({ id: "a", type: "stt" })).toBe("stt")
	})

	it("defaults to llm", () => {
		expect(probeKindOf({ id: "a" })).toBe("llm")
	})
})

describe("probeRef", () => {
	it("builds alias/modelId", () => {
		expect(probeRef("gemini", { id: "flash" })).toBe("gemini/flash")
	})
})

describe("probeAll", () => {
	function recorder() {
		const calls: string[] = []
		return {
			calls,
			probe: async (ref: string, kind: string) => {
				calls.push(`${ref}:${kind}`)
				return { valid: true, source: "fake", kind }
			},
		}
	}

	it("returns nothing for an empty list", async () => {
		const r = recorder()
		expect(await probeAll([], { alias: "a", probe: r.probe, serial: false })).toEqual([])
		expect(r.calls).toEqual([])
	})

	it("probes the only model once", async () => {
		const r = recorder()
		const results = await probeAll(targets("m1"), {
			alias: "a",
			probe: r.probe,
			serial: false,
		})
		expect(results).toEqual([{ modelId: "m1", name: "m1", valid: true, source: "fake", kind: "llm" }])
		expect(r.calls).toEqual(["a/m1:llm"])
	})

	it("uses the display name when there is one", async () => {
		const r = recorder()
		const [result] = await probeAll([{ id: "m1", name: "Model One" }], {
			alias: "a",
			probe: r.probe,
			serial: false,
		})
		expect(result.name).toBe("Model One")
	})

	it("passes the model kind through", async () => {
		const r = recorder()
		await probeAll([{ id: "m1", kind: "image" }], { alias: "a", probe: r.probe, serial: false })
		expect(r.calls).toEqual(["a/m1:image"])
	})

	it("runs the first probe before the rest, even when parallel", async () => {
		const order: string[] = []
		await probeAll(targets("m1", "m2", "m3"), {
			alias: "a",
			serial: false,
			probe: async (ref) => {
				order.push(ref)
				return {}
			},
		})
		expect(order[0]).toBe("a/m1")
	})

	it("probes every model when parallel", async () => {
		const r = recorder()
		const results = await probeAll(targets("m1", "m2", "m3"), {
			alias: "a",
			probe: r.probe,
			serial: false,
		})
		expect(results.map((x) => x.modelId)).toEqual(["m1", "m2", "m3"])
		expect(r.calls).toHaveLength(3)
	})

	it("keeps the caller's order in the result even when parallel", async () => {
		const results = await probeAll(targets("slow", "fast"), {
			alias: "a",
			serial: false,
			probe: async (ref) => {
				if (ref.endsWith("slow")) await new Promise((r) => setTimeout(r, 20))
				return {}
			},
		})
		expect(results.map((x) => x.modelId)).toEqual(["slow", "fast"])
	})

	it("probes serially when asked, one at a time", async () => {
		let inFlight = 0
		let peak = 0
		await probeAll(targets("m1", "m2", "m3"), {
			alias: "a",
			serial: true,
			probe: async () => {
				inFlight++
				peak = Math.max(peak, inFlight)
				await new Promise((r) => setTimeout(r, 5))
				inFlight--
				return {}
			},
		})
		// The warm-up is sequential anyway; the point is the rest never overlap.
		expect(peak).toBe(1)
	})

	it("propagates a probe failure rather than reporting a partial success", async () => {
		await expect(
			probeAll(targets("m1", "m2"), {
				alias: "a",
				serial: true,
				probe: async (ref) => {
					if (ref.endsWith("m2")) throw new Error("probe exploded")
					return {}
				},
			}),
		).rejects.toThrow("probe exploded")
	})
})

describe("needsLiveModels", () => {
	it("asks only for a compatible provider with no known models", () => {
		expect(needsLiveModels({ isCompatible: true, knownModels: 0 })).toBe(true)
	})

	it("does not ask a built-in provider", () => {
		expect(needsLiveModels({ isCompatible: false, knownModels: 0 })).toBe(false)
	})

	it("does not ask when the catalogue already knows the models", () => {
		expect(needsLiveModels({ isCompatible: true, knownModels: 3 })).toBe(false)
	})
})

describe("targetsFromLiveModels", () => {
	it("maps id and name", () => {
		expect(targetsFromLiveModels([{ id: "m1", name: "One" }])).toEqual([{ id: "m1", name: "One" }])
	})

	it("falls back to the name when there is no id", () => {
		expect(targetsFromLiveModels([{ name: "m1" }])).toEqual([{ id: "m1", name: "m1" }])
	})

	it("falls back to the id when there is no name", () => {
		expect(targetsFromLiveModels([{ id: "m1" }])).toEqual([{ id: "m1", name: "m1" }])
	})

	it("drops an entry with neither", () => {
		expect(targetsFromLiveModels([{ context: 100 }, {}])).toEqual([])
	})

	it("drops an empty-string id", () => {
		expect(targetsFromLiveModels([{ id: "" }])).toEqual([])
	})

	it("keeps a numeric id out, since the router needs a string", () => {
		expect(targetsFromLiveModels([{ id: 42 }])).toEqual([])
	})
})
