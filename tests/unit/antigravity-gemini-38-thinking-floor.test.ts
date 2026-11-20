/**
 * Antigravity's Gemini 3.8 lane has no MINIMAL thinking tier.
 *
 * `reasoning_effort: "none"` on an always-on-thinking model is expressed as the
 * lowest supported level. For `gemini-level` models that level is derived from the
 * declared set in `thinkingLevels.ts`, and the format default (`L.gemini`) starts at
 * `minimal`. Gemini 3.8 does not accept it:
 *
 *   HTTP 400  "Thinking level MINIMAL is not supported for this model.
 *              Please retry with other thinking level."
 *
 * So the request failed at the first token — the whole call, not just the thinking
 * part — for any client that asked to disable reasoning, and for the `minimal`
 * effort alias and small thinking budgets, which all clamp through the same path.
 *
 * The fix declares `["low", "medium", "high"]` for Antigravity's `*gemini-3.8*`.
 * Scoped to the provider on purpose: the direct Gemini API is a different backend
 * and still advertises `minimal` for the same model id.
 */
import { describe, expect, it } from "vitest"
import { getThinkingLevels } from "../../apps/web/open-sse/providers/thinkingLevels.js"
import { applyThinking } from "../../apps/web/open-sse/translator/concerns/thinkingUnified.js"

/** Read the level the wire would carry for one client input. */
function levelFor(clientBody: Record<string, unknown>) {
	// `applyThinking` reads the client's ask off the body root (reasoning_effort /
	// thinking), so the knobs belong there, not in a separate intent argument.
	const body: Record<string, any> = {
		model: "gemini-3.8-flash-low",
		...clientBody,
		request: {
			contents: [{ role: "user", parts: [{ text: "hi" }] }],
			generationConfig: {},
		},
	}
	applyThinking("antigravity", "gemini-3.8-flash-low", body, "antigravity")
	return body.request.generationConfig.thinkingConfig?.thinkingLevel
}

describe("Antigravity Gemini 3.8 thinking floor", () => {
	it("declares no minimal tier for Gemini 3.8 on antigravity", () => {
		for (const model of [
			"gemini-3.8-flash",
			"gemini-3.8-flash-low",
			"gemini-3.8-flash-medium",
			"gemini-3.8-flash-high",
		]) {
			expect(getThinkingLevels("antigravity", model)).toEqual(["low", "medium", "high"])
		}
	})

	it("keeps minimal for the direct Gemini API, which is a different backend", () => {
		// Guard the scope of the fix: this pattern is provider-qualified, and an
		// unqualified `*gemini-3.8*` would silently change the gemini provider too.
		expect(getThinkingLevels("gemini", "gemini-3.8-flash")).toContain("minimal")
		expect(getThinkingLevels("gemini-cli", "gemini-3.8-flash")).toContain("minimal")
	})

	it("does not extend the floor to older Gemini models that do accept minimal", () => {
		expect(getThinkingLevels("antigravity", "gemini-3-flash")).toContain("minimal")
	})

	it("clamps every 'off' input to low instead of minimal", () => {
		// Each of these used to reach the wire as MINIMAL and 400.
		for (const clientBody of [
			{ reasoning_effort: "none" },
			{ reasoning_effort: "minimal" },
			{ thinking: { type: "disabled" } },
			{ thinking: { type: "enabled", budget_tokens: 128 } },
			{ thinking: { type: "enabled", budget_tokens: 512 } },
		]) {
			expect(levelFor(clientBody)).toBe("low")
		}
	})

	it("still honours the levels the model does support", () => {
		expect(levelFor({ reasoning_effort: "medium" })).toBe("medium")
		expect(levelFor({ reasoning_effort: "high" })).toBe("high")
	})
})
