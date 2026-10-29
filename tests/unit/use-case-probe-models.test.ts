import { describe, expect, it } from "vitest"
import { makeProbeModels } from "../../apps/api/src/application/providers/probe-models.ts"
import type { ProbeTarget } from "../../apps/api/src/domain/model-probe.ts"

interface HarnessOptions {
	readonly provider?: string
	readonly known?: ProbeTarget[]
	readonly live?: readonly Record<string, unknown>[] | null
	readonly liveThrows?: boolean
	readonly missing?: boolean
	readonly serial?: boolean
	readonly probeThrowsOn?: string
}

function harness(options: HarnessOptions = {}) {
	const calls = { live: 0, probes: [] as string[] }
	const useCase = makeProbeModels({
		connections: {
			async find() {
				if (options.missing) return null
				return { id: "c1", provider: options.provider ?? "gemini" }
			},
			async list() {
				return []
			},
			async create() {
				throw new Error("unused")
			},
			async update() {
				return null
			},
			async remove() {
				return false
			},
		},
		catalogue: {
			label: (p) => p,
			isOpenAICompatible: (p) => p === "ocg",
			isAnthropicCompatible: (p) => p === "acg",
			isCustomEmbedding: () => false,
			isWebCookie: () => false,
			apiKeySubstituteField: () => null,
			isCreatable: () => true,
			usesAwsCredentialForm: () => false,
		},
		knownModels: () => options.known ?? [],
		aliasOf: (provider) => (provider === "gemini" ? "gemini-cli" : provider),
		async liveModels() {
			calls.live++
			if (options.liveThrows) throw new Error("live list refused")
			return options.live ?? null
		},
		async probe(ref, kind) {
			calls.probes.push(`${ref}:${kind}`)
			if (options.probeThrowsOn && ref.includes(options.probeThrowsOn)) {
				throw new Error("probe exploded")
			}
			return { valid: true, kind }
		},
		isSerialProbe: () => options.serial === true,
	})
	return { useCase, calls }
}

describe("run", () => {
	it("404s an unknown connection", async () => {
		const h = harness({ missing: true })
		await expect(h.useCase.run("ghost")).rejects.toThrow("Connection not found")
	})

	it("probes the catalogue's models through the resolved alias", async () => {
		const h = harness({ known: [{ id: "flash" }] })
		const result = await h.useCase.run("c1")
		expect(result).toEqual({
			provider: "gemini",
			connectionId: "c1",
			results: [{ modelId: "flash", name: "flash", valid: true, kind: "llm" }],
		})
		expect(h.calls.probes).toEqual(["gemini-cli/flash:llm"])
	})

	it("does not fetch a live list for a built-in provider", async () => {
		const h = harness({ known: [{ id: "flash" }], live: [{ id: "ignored" }] })
		await h.useCase.run("c1")
		expect(h.calls.live).toBe(0)
	})

	it("does not fetch a live list when the catalogue already knows models", async () => {
		const h = harness({ provider: "ocg", known: [{ id: "m" }], live: [{ id: "ignored" }] })
		await h.useCase.run("c1")
		expect(h.calls.live).toBe(0)
	})

	it("fetches a live list for a compatible provider with no known models", async () => {
		const h = harness({ provider: "ocg", live: [{ id: "live-1", name: "Live" }] })
		const result = await h.useCase.run("c1")
		expect(h.calls.live).toBe(1)
		expect(result.results).toEqual([{ modelId: "live-1", name: "Live", valid: true, kind: "llm" }])
	})

	it("falls back to the catalogue when the live fetch fails", async () => {
		const h = harness({ provider: "ocg", known: [], liveThrows: true })
		// No catalogue models and no live list → nothing to probe.
		await expect(h.useCase.run("c1")).rejects.toThrow("No models configured for this provider")
	})

	it("400s a provider with no models at all", async () => {
		const h = harness({ known: [] })
		await expect(h.useCase.run("c1")).rejects.toThrow("No models configured for this provider")
	})

	it("propagates a probe failure", async () => {
		const h = harness({ known: [{ id: "a" }, { id: "b" }], probeThrowsOn: "b" })
		await expect(h.useCase.run("c1")).rejects.toThrow("probe exploded")
	})

	it("probes serially when the provider needs it", async () => {
		let inFlight = 0
		let peak = 0
		const useCase = makeProbeModels({
			connections: {
				async find() {
					return { id: "c1", provider: "gemini-web" }
				},
				async list() {
					return []
				},
				async create() {
					throw new Error("unused")
				},
				async update() {
					return null
				},
				async remove() {
					return false
				},
			},
			catalogue: {
				label: (p) => p,
				isOpenAICompatible: () => false,
				isAnthropicCompatible: () => false,
				isCustomEmbedding: () => false,
				isWebCookie: () => true,
				apiKeySubstituteField: () => null,
				isCreatable: () => true,
				usesAwsCredentialForm: () => false,
			},
			knownModels: () => [{ id: "a" }, { id: "b" }, { id: "c" }],
			aliasOf: (p) => p,
			liveModels: async () => null,
			async probe() {
				inFlight++
				peak = Math.max(peak, inFlight)
				await new Promise((r) => setTimeout(r, 5))
				inFlight--
				return {}
			},
			isSerialProbe: () => true,
		})
		await useCase.run("c1")
		expect(peak).toBe(1)
	})
})
