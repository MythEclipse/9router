/**
 * Hermes Agent lines that make Antigravity answer a fake 429 RESOURCE_EXHAUSTED.
 *
 * Same Google-side content filter as the Claude Code case (see
 * `antigravity-claude-code-fake-429.test.ts`), different sentences. Measured
 * directly against `v1internal:streamGenerateContent` on an account whose quota
 * endpoint reported 86.8% of the weekly Gemini limit still remaining: a neutral
 * system prompt returned 200, and the same request carrying one of these lines
 * as its `systemInstruction` returned 429 "Resource has been exhausted".
 *
 * Bisected one line at a time against a real Hermes system prompt (upstream
 * `decolua/9router#5745`, PR closed, re-verified here). The rewrites now live in
 * `googlePromptRewrites.ts` so every Google lane applies them, not just the
 * Antigravity one.
 */
import { describe, expect, it } from "vitest"
import { rewritePromptText } from "../../apps/web/open-sse/config/googlePromptRewrites.js"
import { AntigravityExecutor } from "../../apps/web/open-sse/executors/antigravity.js"
import { openaiToAntigravityRequest } from "../../apps/web/open-sse/translator/request/openai-to-gemini.js"

// Verbatim from a Hermes Agent system prompt; each returned 429 on its own.
const TRIGGERS = [
	"<!-- End Hermes runtime environment -->",
	"# Google model operational directives",
	"When the user asks you to build, run, or verify something, the deliverable is a working artifact backed by real tool output — not a description of one.",
	"For help with Hermes Agent itself — configuring, setting up, using, extending, or troubleshooting it — the documentation at https://hermes-agent.nousresearch.com/docs is your authoritative reference and always holds the latest, most up-to-date information.",
	"Mid-turn, the user can steer you: Hermes delivers their message as a standalone user message right after the latest tool results, wrapped exactly as:",
]

const SOUL =
	"You are Hermes Agent, built by Nous Research. Be direct: match the length of your reply to the weight of the ask — a one-line question gets a one-line answer."

/** The systemInstruction text that actually reaches the Antigravity upstream. */
function systemTextSentToAntigravity(systemContent: string): string {
	const body = openaiToAntigravityRequest(
		"gemini-3.8-flash-high",
		{
			messages: [
				{ role: "system", content: systemContent },
				{ role: "user", content: "hi" },
			],
		},
		true,
	)
	const finalBody = new AntigravityExecutor().transformRequest(
		"gemini-3.8-flash-high",
		body,
		true,
		{},
	)
	return finalBody.request.systemInstruction.parts.map((p: { text: string }) => p.text).join("\n")
}

describe("Antigravity strips Hermes lines that trigger a fake 429", () => {
	it("removes every trigger line and keeps the surrounding text", () => {
		const text = systemTextSentToAntigravity(
			[SOUL, "Keep this line.", ...TRIGGERS, "And this one."].join("\n"),
		)
		for (const trigger of TRIGGERS) {
			expect(text).not.toContain(trigger.slice(0, 40))
		}
		expect(text).toContain("Keep this line.")
		expect(text).toContain("And this one.")
	})

	it("keeps a neutral identity instead of the SOUL line", () => {
		// The SOUL line is rewritten rather than dropped, so the prompt still opens
		// with an identity instead of a bare gap.
		const text = systemTextSentToAntigravity(SOUL)
		expect(text).toContain("You are an AI assistant.")
		expect(text).not.toContain("Be direct:")
		expect(text).not.toContain("Nous Research")
	})

	it("keeps the Begin marker, which does not trigger", () => {
		// Only the End marker is filtered; removing both would have been a guess.
		const text = systemTextSentToAntigravity(
			"<!-- Begin Hermes runtime environment -->\nCWD: /home/asephs",
		)
		expect(text).toContain("<!-- Begin Hermes runtime environment -->")
		expect(text).toContain("CWD: /home/asephs")
	})

	it("still rewrites the plain Hermes identity sentence", () => {
		expect(rewritePromptText("You are Hermes Agent, built by Nous Research.")).toBe(
			"You are an AI assistant.",
		)
	})

	it("leaves an ordinary Hermes-free prompt alone", () => {
		const original = "You are a helpful assistant. Answer concisely."
		expect(rewritePromptText(original)).toBe(original)
	})

	it("applies the same rules on the gemini-cli lane", async () => {
		// The filter is on Google's side, so the other cloudcode lane must rewrite
		// too — this is what "global" means for this bug.
		const { GeminiCLIExecutor } = await import("../../apps/web/open-sse/executors/gemini-cli.js")
		const out = new GeminiCLIExecutor().transformRequest(
			"gemini-3.8-flash",
			{
				contents: [{ role: "user", parts: [{ text: "hi" }] }],
				systemInstruction: { parts: [{ text: TRIGGERS[0] }] },
			},
			true,
			{ projectId: "p" },
		)
		const sent = out.request.systemInstruction.parts.map((p: { text: string }) => p.text).join("\n")
		expect(sent).not.toContain("End Hermes runtime environment")
	})
})
