import { describe, expect, it } from "vitest"
import {
	getCapabilitiesForModel,
	MODEL_CAPABILITIES,
	PATTERN_CAPABILITIES,
	PROVIDER_CAPABILITIES,
} from "../../apps/web/open-sse/providers/capabilities.js"

// Capability resolution is a lookup with three sources (provider override, exact model
// name, then pattern) and a precedence order between them. Restructuring the tables is
// only safe if every lookup still returns the same object, so this pins the resolution
// for a wide sample: one model per pattern entry, one per provider override, one per
// exact name. It is deliberately a behavioural test, not a table comparison — the
// tables are what a refactor is allowed to change.

/** One model name per pattern entry, plus names that hit several patterns at once. */
function patternSamples(): string[] {
	const names: string[] = []
	for (const entry of PATTERN_CAPABILITIES) {
		// "*claude*opus-5*" -> "claude-opus-5"
		const name = entry.pattern.replace(/\*/g, "").replace(/\|/g, "-")
		if (name) names.push(name)
	}
	return names
}

/** Model names that several patterns match, where order decides the winner. */
const OVERLAP_SAMPLES = [
	"claude-opus-5-2",
	"claude-sonnet-5",
	"claude-opus-4-6",
	"claude-opus-4-20250101",
	"claude-3-5-sonnet",
	"claude-haiku-5",
	"gemini-4-pro",
	"gemini-3-7-flash",
	"gemini-3-pro-preview",
	"gemini-2-5-pro",
	"gemini-2-0-flash",
	"gemini-image-3",
	"gpt-5-6",
	"gpt-5-6-codex",
	"gpt-5-4",
	"o3",
	"o4-mini",
	"deepseek-v4",
	"grok-4",
	"kimi-k2",
	"glm-5",
	"qwen3-coder",
	"unknown-model-xyz",
]

describe("capability resolution: pinned so the tables can be restructured safely", () => {
	it("resolves every pattern and overlap sample deterministically", () => {
		const samples = [...new Set([...patternSamples(), ...OVERLAP_SAMPLES])].sort()
		const resolved: Record<string, unknown> = {}

		for (const model of samples) {
			const caps = getCapabilitiesForModel("openai", model)
			// Keep only the fields a caller acts on, in a stable order.
			resolved[model] = caps
				? {
						vision: caps.vision ?? false,
						pdf: caps.pdf ?? false,
						audioInput: caps.audioInput ?? false,
						videoInput: caps.videoInput ?? false,
						imageOutput: caps.imageOutput ?? false,
						reasoning: caps.reasoning ?? false,
						search: caps.search ?? false,
						thinkingFormat: caps.thinkingFormat ?? null,
						thinkingCanDisable: caps.thinkingCanDisable ?? null,
						contextWindow: caps.contextWindow ?? null,
						maxOutput: caps.maxOutput ?? null,
					}
				: null
		}

		expect(resolved).toMatchSnapshot()
	})

	it("resolves every exact-name entry", () => {
		const resolved: Record<string, string | null> = {}
		for (const model of Object.keys(MODEL_CAPABILITIES)) {
			const caps = getCapabilitiesForModel("openai", model)
			resolved[model] = caps ? `${caps.contextWindow ?? "-"}/${caps.maxOutput ?? "-"}` : null
		}
		expect(resolved).toMatchSnapshot()
	})

	it("resolves every provider override at its own provider", () => {
		const resolved: Record<string, string | null> = {}
		for (const [provider, models] of Object.entries(
			PROVIDER_CAPABILITIES as Record<string, Record<string, unknown>>,
		)) {
			for (const model of Object.keys(models)) {
				const caps = getCapabilitiesForModel(provider, model)
				resolved[`${provider}/${model}`] = caps
					? `${caps.contextWindow ?? "-"}/${caps.maxOutput ?? "-"}/${caps.thinkingFormat ?? "-"}`
					: null
			}
		}
		expect(resolved).toMatchSnapshot()
	})

	it("a provider override beats the pattern table", () => {
		// opencode reports 1M upstream but rejects above 330k; the override must win.
		const caps = getCapabilitiesForModel("opencode", "deepseek-v4.1-flash-free")
		expect(caps?.contextWindow).toBe(330000)
	})

	it("is stable across repeated calls", () => {
		const a = getCapabilitiesForModel("openai", "claude-opus-5-2")
		const b = getCapabilitiesForModel("openai", "claude-opus-5-2")
		expect(b).toEqual(a)
	})
})
