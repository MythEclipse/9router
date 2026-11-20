/**
 * The provider's own system prompt must be what reaches the provider, and the
 * user's instructions must survive the swap.
 *
 * Two failure modes are pinned here:
 *
 *   1. Forwarding the client's identity verbatim. Tencent's filter rejects a
 *      third-party agent identity (11101), Google's rejects Claude Code's line as
 *      a fake 429 RESOURCE_EXHAUSTED. Both are content-filter hits, not quota.
 *   2. Replacing the *whole* system message with a neutral one-liner. That is what
 *      the previous cloaking did, and it silently deleted real user instructions
 *      that shared the message with the identity line. Measured on `cbai/glm-5.2`:
 *      "You are Claude Code … IMPORTANT: always end with ZEBRA42" came back
 *      without ZEBRA42, while the same instruction alone survived.
 *
 * The CodeBuddy prompt used here was captured from the real CLI (v-latest,
 * 2026-11-20) by pointing `CODEBUDDY_BASE_URL` at a capture proxy: 17,679 chars,
 * 23 tools. It is stored in `config/nativePrompts.ts`.
 */
import { describe, expect, it } from "vitest"

import {
	CODEBUDDY_NATIVE_PROMPT,
	hasNativePrompt,
} from "../../apps/web/open-sse/config/nativePrompts.js"
import {
	hasUserInstructions,
	stripClientIdentity,
} from "../../apps/web/open-sse/shared/clientIdentity.js"
import { composeSystemPrompt } from "../../apps/web/open-sse/shared/nativeSystemPrompt.js"

const CLAUDE_CODE_PROMPT = [
	"You are Claude Code, Anthropic's official CLI for Claude.",
	"You are an interactive CLI tool that helps users with software engineering tasks.",
	"",
	"IMPORTANT: Always end every reply with the exact token ZEBRA42.",
].join("\n")

describe("the captured CodeBuddy prompt is real", () => {
	it("opens with the CLI's identity line", () => {
		expect(CODEBUDDY_NATIVE_PROMPT.trimStart().startsWith("You are CodeBuddy Code.")).toBe(true)
	})

	it("is the full prompt, not a stub", () => {
		// The real capture is ~17.7k chars; anything far smaller means the template
		// got truncated when it was pasted in.
		expect(CODEBUDDY_NATIVE_PROMPT.length).toBeGreaterThan(15_000)
	})

	it("keeps the sections that make it an agent prompt", () => {
		for (const section of ["# Tone and style", "# Doing tasks", "# Tool usage policy", "<env>"]) {
			expect(CODEBUDDY_NATIVE_PROMPT).toContain(section)
		}
	})
})

describe("stripClientIdentity removes the identity but not the user's rules", () => {
	it("drops the Claude Code identity line", () => {
		expect(stripClientIdentity(CLAUDE_CODE_PROMPT)).not.toContain("You are Claude Code")
	})

	it("keeps the user's instruction that shared the message", () => {
		// This is the regression: the old rule replaced the whole message, so this
		// token vanished.
		expect(stripClientIdentity(CLAUDE_CODE_PROMPT)).toContain("ZEBRA42")
	})

	it("drops the SDK identity variant and the billing header", () => {
		const text = [
			"x-anthropic-billing-header: cc_version=2.1.275.f15; cc_entrypoint=cli;",
			"You are a Claude agent, built on Anthropic's Claude Agent SDK.",
			"Answer in Indonesian.",
		].join("\n")
		const out = stripClientIdentity(text)
		expect(out).not.toContain("billing-header")
		expect(out).not.toContain("Claude agent")
		expect(out).toContain("Answer in Indonesian.")
	})

	it("drops CodeBuddy's own branding lines but keeps its instructions", () => {
		const text = [
			"You are CodeBuddy Code.",
			"- /help: Get help with using CodeBuddy Code",
			"Never invent file contents.",
		].join("\n")
		const out = stripClientIdentity(text)
		expect(out).not.toContain("You are CodeBuddy Code")
		expect(out).not.toContain("/help")
		expect(out).toContain("Never invent file contents.")
	})

	it("keeps a line that merely mentions the client inside an instruction", () => {
		// "If you are Claude Code, do X" is an instruction, not an identity, and
		// removing it would lose user intent.
		const text = "If you are Claude Code, always run the tests before answering."
		expect(stripClientIdentity(text)).toContain("always run the tests")
	})

	it("reports nothing to carry when the prompt was only identity", () => {
		expect(hasUserInstructions("You are Claude Code, Anthropic's official CLI for Claude.")).toBe(
			false,
		)
	})
})

describe("composeSystemPrompt puts the provider's prompt first", () => {
	it("uses the native prompt as the base", () => {
		const out = composeSystemPrompt("codebuddy-intl", CLAUDE_CODE_PROMPT, { modelId: "glm-5.2" })
		expect(out.usedNativePrompt).toBe(true)
		expect(out.text.startsWith("You are CodeBuddy Code.")).toBe(true)
	})

	it("carries the user's instruction instead of dropping it", () => {
		const out = composeSystemPrompt("codebuddy-intl", CLAUDE_CODE_PROMPT, { modelId: "glm-5.2" })
		expect(out.carriedClientInstructions).toBe(true)
		expect(out.text).toContain("ZEBRA42")
	})

	it("does not leak the competing client's identity upstream", () => {
		const out = composeSystemPrompt("codebuddy-intl", CLAUDE_CODE_PROMPT, { modelId: "glm-5.2" })
		expect(out.text).not.toContain("You are Claude Code")
		expect(out.text).not.toContain("Anthropic's official CLI")
	})

	it("labels the carried instructions so the model does not read them as identity", () => {
		const out = composeSystemPrompt("codebuddy-intl", CLAUDE_CODE_PROMPT, {})
		expect(out.text).toContain("Additional instructions from the user's client")
	})

	it("fills the environment slots rather than leaving braces", () => {
		const out = composeSystemPrompt("codebuddy-intl", "", { cwd: "/tmp/proj", modelId: "glm-5.2" })
		expect(out.text).toContain("Working directory: /tmp/proj")
		expect(out.text).not.toContain("{{cwd}}")
		expect(out.text).not.toContain("{{")
	})

	it("leaves a provider with no captured prompt completely alone", () => {
		// Opt-in: reverse-engineering one provider must not change another.
		expect(hasNativePrompt("nvidia")).toBe(false)
		const out = composeSystemPrompt("nvidia", "You are Claude Code. Do X.", {})
		expect(out.usedNativePrompt).toBe(false)
		expect(out.text).toBe("You are Claude Code. Do X.")
	})

	it("handles a request that carried no system prompt at all", () => {
		const out = composeSystemPrompt("codebuddy-intl", "", {})
		expect(out.usedNativePrompt).toBe(true)
		expect(out.carriedClientInstructions).toBe(false)
		expect(out.text.startsWith("You are CodeBuddy Code.")).toBe(true)
	})
})
