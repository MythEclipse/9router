import { getPricingForModel } from "@9router/pricing"
import { describe, expect, it } from "vitest"
import {
	getModelsByProviderId,
	isValidModel,
} from "../../apps/web/open-sse/config/providerModels.js"
import { getCapabilitiesForModel } from "../../apps/web/open-sse/providers/capabilities.js"
import { parseModel } from "../../apps/web/open-sse/services/model.js"
import { FORMATS } from "../../apps/web/open-sse/translator/formats.js"
import { translateRequest } from "../../apps/web/open-sse/translator/index.js"
import "../translator/registerAll.js"

const GEMINI_4_CARBON = "google/gemini-4-carbon"
const CLAUDE_FABLE_5_2 = "claude-fable-5-2"

describe("Command Code new models: google/gemini-4-carbon and claude-fable-5-2", () => {
	it("are listed for the commandcode provider in the registry", () => {
		const models = getModelsByProviderId("commandcode")
		expect(models.some((model) => model.id === GEMINI_4_CARBON)).toBe(true)
		expect(models.some((model) => model.id === CLAUDE_FABLE_5_2)).toBe(true)

		expect(isValidModel("commandcode", GEMINI_4_CARBON)).toBe(true)
		expect(isValidModel("commandcode", CLAUDE_FABLE_5_2)).toBe(true)
	})

	it("resolves capabilities with reasoning and vision for both models", () => {
		const geminiCaps = getCapabilitiesForModel("commandcode", GEMINI_4_CARBON)
		expect(geminiCaps).toMatchObject({
			reasoning: true,
			vision: true,
			thinkingFormat: "commandcode",
			thinkingEffortSupported: true,
			contextWindow: 1000000,
			maxOutput: 384000,
		})

		const fableCaps = getCapabilitiesForModel("commandcode", CLAUDE_FABLE_5_2)
		expect(fableCaps).toMatchObject({
			reasoning: true,
			vision: true,
			thinkingFormat: "commandcode",
			thinkingEffortSupported: true,
			contextWindow: 1000000,
			maxOutput: 384000,
		})
	})

	it("prices gemini-4 models from the gemini-4 pattern, not the generic gemini one", () => {
		const expected = { input: 2, output: 10, cached: 0.1, reasoning: 10, cache_creation: 0.1875 }
		expect(getPricingForModel("commandcode", GEMINI_4_CARBON)).toEqual(expected)
		expect(getPricingForModel("antigravity", "gemini-4-carbon-medium")).toEqual(expected)
		// The local pricing table pins the tiered Argon ids to their own intro rate
		// (see gemini-4-argon-antigravity.test.ts), so that exact entry wins over the
		// pattern; the shared pattern fields still prove the gemini-4 rule matched
		// rather than the generic *gemini* one.
		expect(getPricingForModel("vertex", "gemini-4-argon")).toEqual({
			...expected,
			cache_creation: 2,
		})
	})

	it("prices claude-fable-5-2 at the Fable tier", () => {
		expect(getPricingForModel("commandcode", CLAUDE_FABLE_5_2)).toEqual({
			input: 8,
			output: 40,
			cached: 0.2,
			reasoning: 40,
			cache_creation: 10,
		})
	})

	it("routes cmc/<model> to the commandcode wire without modifying the id", () => {
		expect(parseModel(`cmc/${GEMINI_4_CARBON}`)).toMatchObject({
			provider: "commandcode",
			model: GEMINI_4_CARBON,
		})

		const outGemini = translateRequest(
			FORMATS.OPENAI,
			FORMATS.COMMANDCODE,
			GEMINI_4_CARBON,
			{ model: GEMINI_4_CARBON, messages: [{ role: "user", content: "hello" }] },
			true,
			null,
			"cmc" as never,
		)
		expect(outGemini.params.model).toBe(GEMINI_4_CARBON)

		expect(parseModel(`cmc/${CLAUDE_FABLE_5_2}`)).toMatchObject({
			provider: "commandcode",
			model: CLAUDE_FABLE_5_2,
		})

		const outFable = translateRequest(
			FORMATS.OPENAI,
			FORMATS.COMMANDCODE,
			CLAUDE_FABLE_5_2,
			{ model: CLAUDE_FABLE_5_2, messages: [{ role: "user", content: "hello" }] },
			true,
			null,
			"cmc" as never,
		)
		expect(outFable.params.model).toBe(CLAUDE_FABLE_5_2)
	})
})
