import { describe, expect, it } from "vitest"
import { applyThinking } from "../../apps/web/open-sse/translator/concerns/thinkingUnified.js"
import { FORMATS } from "../../apps/web/open-sse/translator/formats.js"

const model = "commandcode-model"
const apply = (body) => {
	applyThinking(FORMATS.COMMANDCODE, model, body, "commandcode")
	return body.params?.reasoning_effort
}

describe("CommandCode reasoning effort levels", () => {
	it("passes declared levels through unchanged", () => {
		for (const level of ["low", "medium", "high", "xhigh", "max"]) {
			expect(apply({ reasoning_effort: level })).toBe(level)
		}
	})

	it("clamps auto to high", () => {
		expect(apply({ reasoning_effort: "auto" })).toBe("high")
		expect(apply({ output_config: { effort: "auto" } })).toBe("high")
		expect(apply({ thinking: { type: "enabled" } })).toBe("high")
	})

	it("clamps minimal to low", () => {
		expect(apply({ reasoning_effort: "minimal" })).toBe("low")
	})

	it("does not emit a level outside the CLI's set", () => {
		for (const bogus of ["ultra", "turbo"]) {
			const body = { reasoning_effort: bogus }
			applyThinking(FORMATS.COMMANDCODE, model, body, "commandcode")
			expect(body.params?.reasoning_effort).toBeUndefined()
		}
	})

	it("drops the field when thinking is explicitly disabled", () => {
		const body = { thinking: { type: "disabled" } }
		applyThinking(FORMATS.COMMANDCODE, model, body, "commandcode")
		expect(body.params?.reasoning_effort).toBeUndefined()
	})

	it("maps an explicit budget to a declared level", () => {
		const level = apply({ thinking: { type: "enabled", budget_tokens: 2048 } })
		expect(["off", "low", "medium", "high", "xhigh", "max"]).toContain(level)
	})
})
