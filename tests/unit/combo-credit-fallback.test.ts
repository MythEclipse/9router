import { describe, expect, it, vi } from "vitest"
import { handleComboChat } from "../../open-sse/services/combo.js"

describe("combo credit fallback", () => {
	it.each([
		["You have insufficient credits to make this request.", true],
		[
			"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
			true,
		],
		["Bad request", true],
	])("routes a 400 response correctly: %s", async (message, shouldContinue) => {
		const body = { messages: [{ role: "user", content: "Hello" }] }
		const models = ["cmc/deepseek/deepseek-v4-pro", "mistral/mistral-medium-latest"]
		const failure = Response.json({ error: { message } }, { status: 400 })
		const success = Response.json({ choices: [{ message: { content: "Hello" } }] })
		const handleSingleModel = vi.fn().mockResolvedValueOnce(failure).mockResolvedValueOnce(success)

		const response = await handleComboChat({
			body,
			models,
			handleSingleModel,
			log: { info: vi.fn(), warn: vi.fn() },
			comboName: "credit-fallback",
			comboStrategy: "fallback",
		})

		const responseStatus = response.status
		const responseBody = await response.json()
		const expectedStatus = shouldContinue ? 200 : 400
		const expectedBody = shouldContinue
			? { choices: [{ message: { content: "Hello" } }] }
			: { error: { message } }
		expect(responseStatus).toBe(expectedStatus)
		expect(responseBody).toEqual(expectedBody)
		expect(handleSingleModel.mock.calls).toEqual(
			(shouldContinue ? models : models.slice(0, 1)).map((model) => [body, model]),
		)
	})
})
