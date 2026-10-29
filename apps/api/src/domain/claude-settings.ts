/**
 * Claude Code's settings are an `env` block, not a provider entry.
 *
 * Claude Code reads `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` from the `env` map of
 * `~/.claude/settings.json`, so this tool does not fit the shared "base URL + key + model"
 * flow at all. Pretending it does would mean translating its screen through a shape it does
 * not have, which is how the base URL ends up under the wrong key.
 *
 * The rules this file states:
 *
 * - a token already in the file is kept. The screen sends whatever is in its field, and a
 *   blank or stale value there must not clear a working token — Reset is the way to clear it;
 * - `CLAUDE_CODE_AUTO_COMPACT_WINDOW` is present only when a concrete window was chosen.
 *   Claude Code derives the window from the model when the key is absent, but treats an
 *   empty value as a window of zero;
 * - reset removes exactly the keys this screen writes, so other `env` entries an operator
 *   added by hand survive.
 */

/** The keys this screen owns inside `env`; reset removes these and nothing else. */
export const CLAUDE_MANAGED_ENV_KEYS = [
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_DEFAULT_OPUS_MODEL",
	"ANTHROPIC_DEFAULT_SONNET_MODEL",
	"ANTHROPIC_DEFAULT_HAIKU_MODEL",
	"API_TIMEOUT_MS",
	"CLAUDE_CODE_AUTO_COMPACT_WINDOW",
] as const

/** Claude Code needs the base URL with `/v1`; it appends the resource path itself. */
export function claudeBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "")
	return `${trimmed}/v1`
}

/** A settings write as Claude's screen sends it. */
export interface ClaudeSettingsWrite {
	readonly env: Record<string, string>
	readonly autoCompactWindow?: unknown
}

/** The result of reading a Claude write, flat so it can be narrowed. */
export interface ClaudeSettingsRead {
	readonly ok: boolean
	readonly error?: string
	readonly write?: ClaudeSettingsWrite
}

/**
 * Reads Claude's screen payload.
 *
 * An `env` object is required because the screen always sends one; a payload without it is a
 * client bug rather than an empty form, and writing on it would produce a config Claude Code
 * cannot use.
 */
export function readClaudeSettings(body: unknown): ClaudeSettingsRead {
	const fields = (body ?? {}) as Record<string, unknown>
	const env = fields.env
	if (!env || typeof env !== "object") {
		return { ok: false, error: "Invalid env object" }
	}

	const cleaned: Record<string, string> = {}
	for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
		if (typeof value === "string") cleaned[key] = value
	}
	if (cleaned.ANTHROPIC_BASE_URL)
		cleaned.ANTHROPIC_BASE_URL = claudeBaseUrl(cleaned.ANTHROPIC_BASE_URL)

	return { ok: true, write: { env: cleaned, autoCompactWindow: fields.autoCompactWindow } }
}

/**
 * Merges a write over the settings Claude Code already has.
 *
 * `hasCompletedOnboarding` is set because a config written by this screen means the operator
 * has configured Claude Code; leaving it unset shows them a first-run wizard over a config
 * that already works.
 */
export function mergeClaudeSettings(
	existing: Record<string, unknown>,
	write: ClaudeSettingsWrite,
): Record<string, unknown> {
	const currentEnv = (existing.env as Record<string, string> | undefined) ?? {}
	const env: Record<string, string> = { ...currentEnv, ...write.env }

	// A token already present wins: the field on screen is a convenience, not the source of
	// truth, and overwriting a working token with a stale one breaks every request.
	if (currentEnv.ANTHROPIC_AUTH_TOKEN) env.ANTHROPIC_AUTH_TOKEN = currentEnv.ANTHROPIC_AUTH_TOKEN

	const window = write.autoCompactWindow
	if (window === undefined || window === null || window === "" || window === false) {
		delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
	} else {
		env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(window)
	}

	return { ...existing, hasCompletedOnboarding: true, env }
}

/** Removes this screen's keys, and the `env` block only when nothing else is left in it. */
export function clearClaudeSettings(existing: Record<string, unknown>): Record<string, unknown> {
	const env = { ...((existing.env as Record<string, string> | undefined) ?? {}) }
	for (const key of CLAUDE_MANAGED_ENV_KEYS) delete env[key]
	const result = { ...existing }
	if (Object.keys(env).length === 0) delete result.env
	else result.env = env
	return result
}
