import {
	clearClaudeSettings,
	mergeClaudeSettings,
	readClaudeSettings,
} from "../../domain/claude-settings.ts"

/**
 * Reads, writes and clears Claude Code's `settings.json`.
 *
 * The file access stays behind a port because the rules above are about *what* the file should
 * contain, and a use-case that touched `node:fs` itself could not be tested without a real
 * home directory.
 */

/** The file operations the Claude settings flow needs. */
export interface ClaudeSettingsPort {
	/** The settings as read, or null when there is no file yet. */
	readonly read: () => Promise<Record<string, unknown> | null>
	/** The settings for a read-modify-write; must fail rather than answer null on a bad file. */
	readonly readForWrite: () => Promise<Record<string, unknown>>
	readonly write: (settings: Record<string, unknown>) => Promise<void>
	/** Writes the MCP servers Claude Code reads from a *different* file. */
	readonly writeMcp?: (enabled: boolean) => Promise<void>
	readonly notInstalledMessage: string
}

/** A flat answer, for the same reason the other CLI-tool answers are flat. */
export interface ClaudeSettingsAnswer {
	readonly status: number
	readonly body: Record<string, unknown>
}

/** Reports whether Claude Code is configured to use this install. */
export async function readClaudeSettingsStatus(
	port: ClaudeSettingsPort,
	isInstalled: () => Promise<boolean>,
): Promise<ClaudeSettingsAnswer> {
	if (!(await isInstalled())) {
		return {
			status: 200,
			body: { installed: false, settings: null, message: port.notInstalledMessage },
		}
	}
	const settings = await port.read()
	return {
		status: 200,
		body: {
			installed: true,
			settings,
			has9Router: Boolean((settings?.env as Record<string, string> | undefined)?.ANTHROPIC_BASE_URL),
		},
	}
}

/** Applies a write, keeping an existing token and the operator's other settings. */
export async function writeClaudeSettings(
	body: unknown,
	port: ClaudeSettingsPort,
	options: { exaMcpEnabled?: boolean } = {},
): Promise<ClaudeSettingsAnswer> {
	const parsed = readClaudeSettings(body)
	if (!parsed.ok || !parsed.write) {
		return { status: 400, body: { error: parsed.error } }
	}

	try {
		const existing = await port.readForWrite()
		await port.write(mergeClaudeSettings(existing, parsed.write))
		// The MCP servers live in `~/.claude.json`, not the settings file; a failure there
		// leaves Claude Code working, so it must not fail the save.
		if (port.writeMcp) await port.writeMcp(options.exaMcpEnabled === true).catch(() => undefined)
		return { status: 200, body: { success: true, message: "Settings updated successfully" } }
	} catch (error) {
		return {
			status: 500,
			body: { error: error instanceof Error ? error.message : "Failed to update claude settings" },
		}
	}
}

/** Removes this screen's keys, leaving everything else in place. */
export async function resetClaudeSettings(port: ClaudeSettingsPort): Promise<ClaudeSettingsAnswer> {
	try {
		const existing = await port.readForWrite()
		await port.write(clearClaudeSettings(existing))
		if (port.writeMcp) await port.writeMcp(false).catch(() => undefined)
		return { status: 200, body: { success: true, message: "Settings reset successfully" } }
	} catch (error) {
		return {
			status: 500,
			body: { error: error instanceof Error ? error.message : "Failed to reset claude settings" },
		}
	}
}
