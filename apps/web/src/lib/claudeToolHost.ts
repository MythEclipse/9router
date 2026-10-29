import { exec } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import type { ClaudeSettingsPort } from "9router-api/application/claude-tools/manage-claude-settings"
import { DEFAULT_PLUGINS } from "@/shared/constants/coworkPlugins"
import { readConfigForWrite } from "./cliTools/configWrite"

/**
 * Claude Code's two files.
 *
 * The settings live in `~/.claude/settings.json`, but the CLI reads `mcpServers` from
 * `~/.claude.json` — a different file at the home root. Writing the MCP entry into the
 * settings file looks right and does nothing, which is why the port exposes it separately.
 */

const execAsync = promisify(exec)

const CLAUDE_SETTINGS_PATH = () => path.join(os.homedir(), ".claude", "settings.json")
const CLAUDE_JSON_PATH = () => path.join(os.homedir(), ".claude.json")

const EXA_PLUGIN = DEFAULT_PLUGINS.find((p) => p.name === "exa")

/** Claude Code is installed when its CLI answers or its settings file exists. */
export async function isClaudeInstalled(): Promise<boolean> {
	try {
		const isWindows = os.platform() === "win32"
		const command = isWindows ? "where claude" : "which claude"
		const env = isWindows
			? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
			: process.env
		await execAsync(command, { windowsHide: true, env })
		return true
	} catch {
		try {
			await fs.access(CLAUDE_SETTINGS_PATH())
			return true
		} catch {
			return false
		}
	}
}

/**
 * Adds or removes the Exa MCP entry in `~/.claude.json`.
 *
 * Removal touches only the `exa` key: an operator's own MCP servers stay, and an empty
 * `mcpServers` map is deleted so Claude Code does not read a section with nothing in it.
 */
async function writeClaudeJsonMcp(enabled: boolean): Promise<void> {
	const filePath = CLAUDE_JSON_PATH()
	let data: { mcpServers?: Record<string, unknown> } = {}
	try {
		data = JSON.parse(await fs.readFile(filePath, "utf-8"))
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}

	if (enabled && EXA_PLUGIN) {
		data.mcpServers = {
			...(data.mcpServers ?? {}),
			exa: { type: EXA_PLUGIN.transport, url: EXA_PLUGIN.url },
		}
	} else if (data.mcpServers) {
		delete data.mcpServers.exa
		if (Object.keys(data.mcpServers).length === 0) delete data.mcpServers
	}
	await fs.writeFile(filePath, JSON.stringify(data, null, 2))
}

export const claudeSettingsPort: ClaudeSettingsPort = {
	read: async () => {
		try {
			const content = await fs.readFile(CLAUDE_SETTINGS_PATH(), "utf-8")
			return JSON.parse(content.replace(/,(\s*[}\]])/g, "$1")) as Record<string, unknown>
		} catch {
			return null
		}
	},
	readForWrite: () =>
		readConfigForWrite(
			fs,
			CLAUDE_SETTINGS_PATH(),
			(raw) => JSON.parse(raw) as Record<string, unknown>,
		),
	write: async (settings) => {
		await fs.mkdir(path.dirname(CLAUDE_SETTINGS_PATH()), { recursive: true })
		await fs.writeFile(CLAUDE_SETTINGS_PATH(), JSON.stringify(settings, null, 2))
	},
	writeMcp: writeClaudeJsonMcp,
	notInstalledMessage: "Claude Code CLI is not installed",
}
