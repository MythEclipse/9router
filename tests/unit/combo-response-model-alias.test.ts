import { describe, expect, it } from "vitest"
import { applyModelAlias, calledModelName } from "../../open-sse/utils/modelAlias"

/**
 * A caller that asks for a combo (or a studio alias) must never learn which
 * internal provider/model answered. The gateway labels the payload with the name
 * that was called; the real target stays in the console and usage stats.
 *
 * Regression: both combo entry points passed `null` for `requestedModel`, so
 * `calledModelName` returned null and the response carried the internal name —
 * POST {"model":"claude-opus-5-5"} came back as "cbai/deepseek-v4.1-flash".
 */
describe("combo response model naming", () => {
	it("names the response after the combo, not the member that served it", () => {
		const requestedModel = "claude-opus-5-5"
		const servedModel = "cbai/deepseek-v4.1-flash"

		const alias = calledModelName(requestedModel, servedModel)
		expect(alias).toBe("claude-opus-5-5")

		const response = { model: servedModel, choices: [] }
		expect(applyModelAlias(response, alias)).toBe(true)
		expect(response.model).toBe("claude-opus-5-5")
	})

	it("stays silent when the caller already spoke the resolved model", () => {
		expect(calledModelName("cbai/deepseek-v4.1-flash", "cbai/deepseek-v4.1-flash")).toBeNull()
	})

	it("stays silent for an absent alias so a plain request is untouched", () => {
		expect(calledModelName(null, "cbai/deepseek-v4.1-flash")).toBeNull()
		expect(calledModelName("", "cbai/deepseek-v4.1-flash")).toBeNull()
		expect(calledModelName("   ", "cbai/deepseek-v4.1-flash")).toBeNull()
	})

	it("relabels nested Claude and Responses payloads", () => {
		const claude = { type: "message_start", message: { model: "claude-sonnet-4-5" } }
		applyModelAlias(claude, "my-combo")
		expect(claude.message.model).toBe("my-combo")

		const responses = { response: { model: "gpt-5-codex", modelVersion: "gpt-5-codex" } }
		applyModelAlias(responses, "my-combo")
		expect(responses.response.model).toBe("my-combo")
		expect(responses.response.modelVersion).toBe("my-combo")
	})

	it("leaves every non-model field alone", () => {
		const response = {
			model: "internal/model",
			created: 1793102811,
			choices: [{ message: { role: "assistant", content: "Hello!" }, finish_reason: "stop" }],
			usage: { prompt_tokens: 13, completion_tokens: 10, total_tokens: 23 },
		}
		const before = JSON.parse(JSON.stringify(response))
		applyModelAlias(response, "claude-opus-5-5")

		expect(response.model).toBe("claude-opus-5-5")
		expect(response.created).toBe(before.created)
		expect(response.choices).toEqual(before.choices)
		expect(response.usage).toEqual(before.usage)
	})

	it("ignores payloads that carry no model field", () => {
		expect(applyModelAlias({ choices: [] }, "my-combo")).toBe(false)
		expect(applyModelAlias(null, "my-combo")).toBe(false)
	})
})
