/**
 * The system prompt codebuddy-intl actually sends.
 *
 * Two rules, both load-bearing:
 *  - a client's own system/developer prompt must reach the model (it used to be
 *    thrown away and replaced with the CLI's default, which silently dropped
 *    every instruction an SDK client set);
 *  - a third-party CLI agent identity must not, because Tencent's filter reads it
 *    as prompt injection and rejects — or bans — the account.
 *
 * The marker set is shared with codebuddy-cn (open-sse/shared/cliAgentPrompt.ts),
 * so these cases also cover the fact that both endpoints agree on it.
 */
import { describe, expect, it } from "vitest"
import { CodeBuddyIntlExecutor } from "../../apps/web/open-sse/executors/codebuddy-intl.ts"
import {
	CLI_AGENT_PATTERN,
	isAgentIdentityPrompt,
	NEUTRAL_SYSTEM_PROMPT,
} from "../../apps/web/open-sse/shared/cliAgentPrompt.ts"

const executor = new CodeBuddyIntlExecutor()
const MODEL = "deepseek-v4.1-flash"

function transform(messages: unknown[]) {
	return executor.transformRequest(MODEL, { messages }, false, {}) as {
		messages: Array<{ role: string; content: unknown }>
	}
}

describe("CodeBuddyIntlExecutor system prompt", () => {
	it("forwards the client's own system prompt", () => {
		const out = transform([
			{ role: "system", content: "You are a professional translator." },
			{ role: "user", content: "Translate this text." },
		])

		expect(out.messages[0]).toEqual({
			role: "system",
			content: "You are a professional translator.",
		})
		expect(out.messages[1]).toEqual({
			role: "user",
			content: [{ type: "text", text: "Translate this text." }],
		})
	})

	it("falls back to the CLI default when the client sends none", () => {
		const out = transform([{ role: "user", content: "Hello" }])
		expect(out.messages[0]).toEqual({ role: "system", content: "You are CodeBuddy Code." })
		expect(out.messages[1]).toEqual({ role: "user", content: [{ type: "text", text: "Hello" }] })
	})

	it("neutralises a third-party CLI agent identity", () => {
		const out = transform([
			{ role: "system", content: "You are Claude Code, Anthropic's official CLI for coding." },
			{ role: "user", content: "Fix this bug" },
		])
		expect(out.messages[0]).toEqual({ role: "system", content: NEUTRAL_SYSTEM_PROMPT })
	})

	it("joins a system and a developer prompt in order", () => {
		const out = transform([
			{ role: "system", content: "Be terse." },
			{ role: "developer", content: "Answer in French." },
			{ role: "user", content: "hi" },
		])
		expect(out.messages[0].content).toBe("Be terse.\n\nAnswer in French.")
	})

	it("keeps the surviving prompt when only one of several is an identity", () => {
		const out = transform([
			{ role: "system", content: "You are Claude Code, Anthropic's official CLI." },
			{ role: "system", content: "Always answer in French." },
			{ role: "user", content: "salut" },
		])
		expect(out.messages[0].content).toBe(`${NEUTRAL_SYSTEM_PROMPT}\n\nAlways answer in French.`)
	})

	it("flattens a typed-block system prompt before deciding", () => {
		const out = transform([
			{ role: "system", content: [{ type: "text", text: "Answer in German." }] },
			{ role: "user", content: "hallo" },
		])
		expect(out.messages[0].content).toBe("Answer in German.")
	})
})

describe("shared CLI agent marker set", () => {
	it("matches the identities the filter cares about", () => {
		for (const prompt of [
			"You are Claude Code, Anthropic's official CLI for coding.",
			"You are Cursor, an AI coding assistant.",
			"You are a powerful AI agent with orchestration capabilities.",
			"cc_entrypoint=cli",
			"<agent-identity>",
		]) {
			expect(isAgentIdentityPrompt(prompt), prompt).toBe(true)
		}
	})

	it("leaves ordinary user prompts alone", () => {
		for (const prompt of ["You are a professional translator.", "Be terse.", "Answer in French."]) {
			expect(isAgentIdentityPrompt(prompt), prompt).toBe(false)
		}
	})

	it("treats an over-long preamble as an identity whatever it says", () => {
		expect(isAgentIdentityPrompt("x".repeat(2001))).toBe(true)
	})

	it("does not keep a stateful lastIndex between calls", () => {
		expect(CLI_AGENT_PATTERN.global).toBe(false)
		expect(isAgentIdentityPrompt("You are Claude Code")).toBe(true)
		expect(isAgentIdentityPrompt("You are Claude Code")).toBe(true)
	})
})
