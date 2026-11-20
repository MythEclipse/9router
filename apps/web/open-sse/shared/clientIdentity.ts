/**
 * Splitting a client's system prompt into "who it thinks it is" and "what the
 * user actually asked for".
 *
 * The old cloaking replaced the *whole* system message with a one-line neutral
 * identity whenever it matched an agent marker. That silently deleted real user
 * instructions that shared the message: measured on `cbai/glm-5.2`, a prompt
 * reading "You are Claude Code … IMPORTANT: always end with ZEBRA42" came back
 * without ZEBRA42, while the same instruction without the Claude Code line
 * survived. Dropping the client identity is the goal; dropping the user's
 * instruction is a bug.
 *
 * So the prompt is not discarded, it is *demoted*: lines that are only client
 * identity/branding are removed, and whatever remains — the user's own rules —
 * is carried into the request as context, after the provider's native prompt.
 *
 * Only lines that *are* the identity are removed, never lines that merely
 * mention it, so "You are Claude Code" goes but "If you are Claude Code, do X"
 * stays.
 */

/** Lines that exist only to establish a third-party client's identity. */
const CLIENT_IDENTITY_LINE_PATTERNS: RegExp[] = [
	// "You are Claude Code, Anthropic's official CLI for Claude." and SDK variant.
	/^\s*You are Claude Code\b[^\n]*$/i,
	// "You are a Claude agent, built on Anthropic's Claude Agent SDK."
	/^\s*You are a Claude agent\b[^\n]*$/i,
	// "You are CodeBuddy Code." / "You are Cursor." / "You are Windsurf."
	/^\s*You are (?:CodeBuddy Code|CodeBuddy|Cursor|Windsurf|Cline|Aider|Continue|Copilot|Cody|OpenCode)\b[^\n]*$/i,
	// Hermes' own identity/SOUL line.
	/^\s*You are Hermes(?: Agent)?\b[^\n]*$/i,
	// The billing header Claude Code prepends.
	/^\s*x-anthropic-billing-header:[^\n]*$/i,
	// "<agent-identity>" / "<Role>" blocks are pure identity.
	/^\s*<\/?(?:agent-identity|Role|Behavior_Instructions)>[^\n]*$/i,
]

/**
 * A line that is *only* branding: mentions the client name but carries no
 * instruction. Used to drop things like "CodeBuddy Code has a /help command".
 */
const CLIENT_BRANDING_LINE_PATTERNS: RegExp[] = [
	/^\s*-\s*\/help:\s*Get help with using\b/i,
	/^\s*-\s*To give feedback, users should report the issue at\b/i,
	/^\s*\*\*PRIORITY \d+ \(Built-in docs/i,
	/^\s*\*\*PRIORITY \d+ \(Web docs/i,
	/^\s*When the user directly asks about\b[^\n]*\b(?:CodeBuddy|Cursor|Windsurf|Claude Code)\b[^\n]*$/i,
]

/** Whether one line is purely a client identity/branding line. */
function isClientOnlyLine(line: string): boolean {
	const trimmed = line.trim()
	if (!trimmed) return false
	for (const pattern of CLIENT_IDENTITY_LINE_PATTERNS) if (pattern.test(trimmed)) return true
	for (const pattern of CLIENT_BRANDING_LINE_PATTERNS) if (pattern.test(trimmed)) return true
	return false
}

/**
 * Remove client identity/branding lines, keeping everything else.
 *
 * Returns the surviving text; empty means the prompt was *entirely* client
 * identity, which is the only case where nothing needs carrying over.
 */
export function stripClientIdentity(systemText: string): string {
	if (!systemText) return ""
	const kept = systemText
		.split("\n")
		.filter((line) => !isClientOnlyLine(line))
		.join("\n")
	// Collapse the blank runs the removals leave behind, so the result does not
	// open with a screen of empty lines.
	return kept.replace(/\n{3,}/g, "\n\n").trim()
}

/**
 * Whether the text still carries something worth forwarding after the client
 * identity is removed. A prompt that was *only* identity has nothing left.
 */
export function hasUserInstructions(systemText: string): boolean {
	const rest = stripClientIdentity(systemText)
	// A handful of characters is not an instruction; require a real line of text.
	return rest.replace(/\s+/g, " ").trim().length >= 24
}
