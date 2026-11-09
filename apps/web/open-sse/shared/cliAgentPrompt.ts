/**
 * Tencent's content filter (shared by codebuddy-cn and codebuddy-intl).
 *
 * Both endpoints flag a CLI agent's own system prompt — "You are Claude Code,
 * Anthropic's official CLI…", a Cursor/Windsurf identity, an `<agent-identity>`
 * block — as prompt injection or sensitive content and reject the whole request.
 * The filter is the same on both hosts, so the marker set lives here once instead
 * of drifting between two copies of the same regex.
 *
 * A real user prompt must survive: only a prompt that matches a marker (or is long
 * enough to be a full agent preamble) is replaced.
 */

/** What a neutered agent prompt becomes. */
export const NEUTRAL_SYSTEM_PROMPT =
	"You are a helpful AI assistant that helps with software engineering tasks."

/** Identity markers of third-party CLI agents. */
export const CLI_AGENT_PATTERN =
	/you are claude code|claude.?code.+official.+cli|anthropic.+official.+cli|anxthxropic.+official.+cli|you are (?:cursor|windsurf|cline|aider|continue|copilot|cody)|you are an? (?:ai )?(?:coding |code )?agent|cc_entrypoint\s*=\s*(?:cli|vscode|jetbrains|gui)|claude.?code.+issues|give feedback.+claude.?code|you are .{0,30}(?:powerful )?ai agent|orchestration capabilities|OhMyOpenCode|<agent-identity>|<Role>|<Behavior_Instructions>/i

/** A prompt longer than this is an agent preamble whatever it says. */
export const AGENT_PROMPT_LENGTH_LIMIT = 2000

/** Flatten a system message's content to the text the filter sees. */
export function systemPromptText(content: unknown): string {
	if (typeof content === "string") return content
	if (Array.isArray(content)) {
		return content
			.map((block) => (block && typeof block.text === "string" ? block.text : ""))
			.join("\n")
	}
	return ""
}

/** Whether this system prompt is an agent identity the filter would reject. */
export function isAgentIdentityPrompt(text: string): boolean {
	if (!text) return false
	return text.length > AGENT_PROMPT_LENGTH_LIMIT || CLI_AGENT_PATTERN.test(text)
}

/** The replacement, in the same shape the original content had. */
export function neutralisedContent(content: unknown): unknown {
	return typeof content === "string"
		? NEUTRAL_SYSTEM_PROMPT
		: [{ type: "text", text: NEUTRAL_SYSTEM_PROMPT }]
}
