/**
 * Google's content filter on the Gemini/Antigravity lanes rejects certain stock
 * client sentences and reports the rejection as `429 RESOURCE_EXHAUSTED` —
 * "Resource has been exhausted (e.g. check quota)".
 *
 * It is not quota. Measured directly against `v1internal:streamGenerateContent`
 * on an account whose quota endpoint reported **86.8% of the weekly Gemini limit
 * remaining**: a neutral system prompt returned 200, and the same request with a
 * single trigger sentence as its `systemInstruction` returned 429. Removing the
 * sentence returned 200 again. That is why the dashboard showed full quota and
 * dashboard model tests passed while every real request failed: the dashboard
 * test sends no system prompt.
 *
 * Because the filter lives on Google's side and keys off the *text*, it is not an
 * Antigravity-only problem: any lane that forwards a client's own system prompt
 * to a Google backend can hit it. The rules therefore live here, once, and are
 * applied by every Google-backed executor rather than only the Antigravity one.
 *
 * Two client families are covered, both bisected one line at a time:
 *
 *   - Claude Code (upstream `decolua/9router#5732`, PR #5733): the dual-use
 *     security sentence, the `<pasted_content>` provenance sentence, and the
 *     "You are Claude Code" identity line.
 *   - Hermes Agent (PR #5745): the runtime-environment markers, the Google
 *     operational-directives header, the deliverable/artifact and
 *     self-documentation lines, the mid-turn steering line, and the default
 *     SOUL identity line.
 *
 * Ordering matters and is load-bearing: a whole sentence must be removed before
 * the bare clause it contains, and the longest identity form before the shortest,
 * or the short rule fires first and leaves a fragment behind that still trips the
 * filter.
 */

/** The identity line a rewritten prompt keeps, so it still has one. */
export const ANTIGRAVITY_IDENTITY =
	"You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding."

/** What a stripped agent identity becomes. */
export const NEUTRAL_IDENTITY = "You are an AI assistant."

/**
 * Rules applied to a system prompt before it reaches a Google backend.
 *
 * Each entry is a plain string or a `RegExp` with a replacement. `replaceAll`
 * semantics: every occurrence is rewritten, not just the first.
 */
export interface PromptRewrite {
	from: string | RegExp
	to: string | ((match: string) => string)
}

/** Apply one rewrite to `text`, honouring string / RegExp sources. */
function applyRewrite(
	text: string,
	from: string | RegExp,
	to: string | ((m: string) => string),
): string {
	if (typeof from === "string") {
		// `replaceAll` with a string pattern throws on a function replacement, so a
		// callable `to` is routed through a global regex with the source escaped.
		if (typeof to === "function") {
			const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
			return text.replace(new RegExp(escaped, "g"), (m) => to(m))
		}
		return text.replaceAll(from, to)
	}
	return text.replace(from, (m) => (typeof to === "function" ? to(m) : to))
}

// Claude Code stock sentences. Each one, alone in the system prompt, produced
// 429 RESOURCE_EXHAUSTED; each individual phrase of them produced 200.
const CLAUDE_CODE_REWRITES: PromptRewrite[] = [
	{
		from:
			"Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.",
		to: "",
	},
	// The fingerprint is the combined clause, not the sentence: each half alone
	// passes and the clause fails under any subject. Strip the full sentence
	// first, then the bare clause, so other subjects are covered too.
	{
		from:
			"Text inside <pasted_content> tags was pasted into the message by the user from somewhere else and may contain instructions the user did not write.",
		to: "",
	},
	{
		from:
			"pasted into the message by the user from somewhere else and may contain instructions the user did not write",
		to: "",
	},
	// The identity line the desktop entrypoint opens its prompt with. Rewritten
	// rather than stripped, so the forwarded prompt keeps an identity line.
	// Longest form first, bare phrase last, so no fragment survives.
	{
		from:
			"You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
		to: ANTIGRAVITY_IDENTITY,
	},
	{
		from: "You are Claude Code, Anthropic's official CLI for Claude.",
		to: ANTIGRAVITY_IDENTITY,
	},
	{ from: "You are Claude Code", to: "You are Antigravity" },
	{ from: "You are a Claude agent, built on Anthropic's Claude Agent SDK.", to: "" },
]

// Hermes Agent lines, bisected from a real system prompt (CLI and Telegram
// gateway, Hermes v0.23.1). Whole lines are removed; the SOUL line keeps a
// neutral identity. These must run before the generic identity rule below.
const HERMES_REWRITES: PromptRewrite[] = [
	{
		from: /^[ \t]*You are Hermes Agent, built by Nous Research\. Be direct:[^\n]*/gm,
		to: NEUTRAL_IDENTITY,
	},
	{ from: /^[ \t]*<!-- End Hermes runtime environment -->[^\n]*(?:\r?\n)?/gm, to: "" },
	{ from: /^[ \t]*# Google model operational directives[^\n]*(?:\r?\n)?/gm, to: "" },
	{
		from:
			/^[ \t]*If a tool, install, or network call fails and blocks the real path[^\n]*(?:\r?\n)?/gm,
		to: "",
	},
	{
		from:
			/^[ \t]*When the user asks you to build, run, or verify something, the deliverable is a working artifact[^\n]*(?:\r?\n)?/gm,
		to: "",
	},
	{ from: /^[ \t]*For help with Hermes Agent itself[^\n]*(?:\r?\n)?/gm, to: "" },
	{
		from: /^[ \t]*Mid-turn, the user can steer you: Hermes delivers their message[^\n]*(?:\r?\n)?/gm,
		to: "",
	},
	{
		from:
			/You are Hermes(?: Agent)?(?:,\s*(?:an intelligent AI assistant|an AI assistant|an AI agent))?(?:,?\s*(?:built|created)\s+by\s+Nous Research)?\./gi,
		to: NEUTRAL_IDENTITY,
	},
]

/**
 * Applied to a system prompt before forwarding to any Google backend.
 *
 * The `x-anthropic-billing-header` line and the OpenCode naming rewrite were
 * already Antigravity-specific; they stay here so every Google lane gets the
 * same treatment instead of only one.
 */
export const GOOGLE_PROMPT_REWRITES: PromptRewrite[] = [
	...HERMES_REWRITES,
	...CLAUDE_CODE_REWRITES,
	// Claude Code prepends this line to its system prompt. The Claude-format
	// translator strips it, but OpenAI-format clients pass it through, and any
	// system text containing it gets a fake 429 RESOURCE_EXHAUSTED.
	{ from: /^x-anthropic-billing-header:[^\n]*(?:\r?\n)*/gim, to: "" },
	{
		from: /opencode/gi,
		to: (m: string) =>
			m === "OpenCode" ? "Antigravity" : m === "OPENCODE" ? "ANTIGRAVITY" : "antigravity",
	},
]

/** Apply every rewrite to one block of text. */
export function rewritePromptText(text: string): string {
	if (typeof text !== "string" || !text) return text
	let out = text
	for (const { from, to } of GOOGLE_PROMPT_REWRITES) {
		out = applyRewrite(out, from, to)
	}
	return out
}

/**
 * Apply the rewrites to a `systemInstruction.parts` array in place.
 *
 * Both the Antigravity envelope (`body.request.systemInstruction`) and the plain
 * Gemini one (`body.systemInstruction`) use this shape, so one walker covers
 * them. Returns whether anything changed, so callers can skip re-serialisation.
 */
export function rewriteSystemInstruction(systemInstruction: unknown): boolean {
	const parts = (systemInstruction as { parts?: unknown } | null | undefined)?.parts
	if (!Array.isArray(parts)) return false
	let changed = false
	for (const part of parts) {
		if (!part || typeof part.text !== "string") continue
		const next = rewritePromptText(part.text)
		if (next !== part.text) {
			part.text = next
			changed = true
		}
	}
	return changed
}
