import { exec } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import type { ToolConfigPort } from "9router-api/application/cli-tools/manage-tool-settings"

const execAsync = promisify(exec)

/**
 * Kilo Code CLI's own layout.
 *
 * The CLI keeps every provider under one `auth.json` keyed by provider name, and the VS Code
 * extension keeps its settings in the editor's own file. Both spellings of this install's
 * provider key are recognised: `openai-compatible` is what the CLI expects, `9router` is what
 * an earlier version of this screen wrote.
 */

const KILO_DATA_DIR = () => path.join(os.homedir(), ".local", "share", "kilo")
const KILO_AUTH_PATH = () => path.join(KILO_DATA_DIR(), "auth.json")
const VSCODE_SETTINGS_PATH = () =>
	path.join(os.homedir(), ".config", "Code", "User", "settings.json")

/**
 * Reads a JSON file, tolerating JSONC and a missing file.
 *
 * A config the tool itself can parse but `JSON.parse` cannot (trailing commas are common in
 * editor settings) must not read as 500: the screen would misreport it as "tool not installed",
 * and the operator would reinstall a tool that is already there.
 */
async function readJson(filePath: string): Promise<Record<string, unknown> | null> {
	try {
		const content = await fs.readFile(filePath, "utf-8")
		return JSON.parse(content.replace(/,(\s*[}\]])/g, "$1"))
	} catch {
		return null
	}
}

async function isKiloInstalled(): Promise<boolean> {
	try {
		const isWindows = os.platform() === "win32"
		const env = isWindows
			? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
			: process.env
		await execAsync(isWindows ? "where kilo" : "which kilo", { windowsHide: true, env })
		return true
	} catch {
		// The CLI may be installed without being on this process's PATH.
		try {
			await fs.access(KILO_AUTH_PATH())
			return true
		} catch {
			return false
		}
	}
}

export const kiloSettingsConfig: ToolConfigPort = {
	path: KILO_AUTH_PATH(),
	read: () => readJson(KILO_AUTH_PATH()),
	write: async (text) => {
		await fs.mkdir(KILO_DATA_DIR(), { recursive: true })
		await fs.writeFile(KILO_AUTH_PATH(), text)
	},
	installKeys: ["openai-compatible", "9router"],
	storedBaseUrl: (config) => {
		const entry = (config?.["openai-compatible"] ?? config?.["9router"]) as
			| Record<string, unknown>
			| undefined
		const value = entry?.baseUrl ?? entry?.baseURL
		return typeof value === "string" ? value : null
	},
	apply: (config, input) => ({
		...config,
		"openai-compatible": {
			type: "api-key",
			apiKey: input.apiKey,
			baseUrl: input.baseUrl,
			model: input.model,
		},
	}),
}

/** Mirror the settings into the VS Code extension, best-effort by design. */
export async function writeKiloVsCodeSettings(
	input: { baseUrl: string; apiKey: string; model: string },
	remove = false,
): Promise<void> {
	const settings = (await readJson(VSCODE_SETTINGS_PATH())) ?? {}
	if (remove) {
		delete settings["kilocode.customProvider"]
		delete settings["kilocode.defaultModel"]
	} else {
		settings["kilocode.customProvider"] = {
			name: "9Router",
			baseURL: input.baseUrl,
			apiKey: input.apiKey,
		}
		settings["kilocode.defaultModel"] = input.model
	}
	await fs.mkdir(path.dirname(VSCODE_SETTINGS_PATH()), { recursive: true })
	await fs.writeFile(VSCODE_SETTINGS_PATH(), `${JSON.stringify(settings, null, 2)}\n`)
}

export { isKiloInstalled }
