import { describe, expect, it } from "vitest"
import { claudeToKiroRequest } from "../../apps/web/open-sse/translator/request/claude-to-kiro.js"
import { openaiToKiroRequest } from "../../apps/web/open-sse/translator/request/openai-to-kiro.js"

for (const [name, translate, body] of [
	["OpenAI", openaiToKiroRequest, { messages: [{ role: "user", content: "hello" }] }],
	["Claude", claudeToKiroRequest, { messages: [{ role: "user", content: "hello" }] }],
]) {
	describe(`${name} Kiro minimal wire payload`, () => {
		it("omits unsupported agent fields", () => {
			const payload = translate("kiro/claude-sonnet-4.5", body, true, {})
			expect(payload).not.toHaveProperty("agentMode")
			expect(payload.conversationState).not.toHaveProperty("agentContinuationId")
			expect(payload.conversationState).not.toHaveProperty("agentTaskType")
			expect(payload.conversationState.chatTriggerType).toBe("MANUAL")
			expect(payload.conversationState.currentMessage.userInputMessage.origin).toBe("AI_EDITOR")
		})
	})
}
