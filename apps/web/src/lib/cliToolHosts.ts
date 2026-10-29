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
	baseUrlSuffix: "with-v1",
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

/**
 * Cline's own layout, which is two files.
 *
 * The provider choice and model live in `globalState.json`; the key lives in `secrets.json`.
 * Cline expects the base URL **without** `/v1` because it appends the full path itself, and it
 * records the provider per mode, so both modes have to be set or one of them keeps using
 * Cline's own provider.
 */

const CLINE_DATA_DIR = () => path.join(os.homedir(), ".cline", "data")
const CLINE_STATE_PATH = () => path.join(CLINE_DATA_DIR(), "globalState.json")
const CLINE_SECRETS_PATH = () => path.join(CLINE_DATA_DIR(), "secrets.json")

async function isClineInstalled(): Promise<boolean> {
	try {
		const isWindows = os.platform() === "win32"
		const env = isWindows
			? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
			: process.env
		await execAsync(isWindows ? "where cline" : "which cline", { windowsHide: true, env })
		return true
	} catch {
		try {
			await fs.access(CLINE_STATE_PATH())
			return true
		} catch {
			return false
		}
	}
}

export const clineSettingsConfig: ToolConfigPort = {
	path: CLINE_STATE_PATH(),
	read: () => readJson(CLINE_STATE_PATH()),
	write: async (text) => {
		await fs.mkdir(CLINE_DATA_DIR(), { recursive: true })
		await fs.writeFile(CLINE_STATE_PATH(), text)
	},
	baseUrlSuffix: "without-v1",
	// Cline has no provider key of its own; "openai" in either mode is what points here.
	installKeys: [],
	storedBaseUrl: (config) => {
		const state = config ?? {}
		const usesOpenAi = state.actModeApiProvider === "openai" || state.planModeApiProvider === "openai"
		return usesOpenAi && typeof state.openAiBaseUrl === "string" ? state.openAiBaseUrl : null
	},
	apply: (config, input) => ({
		...config,
		actModeApiProvider: "openai",
		planModeApiProvider: "openai",
		openAiBaseUrl: input.baseUrl,
		openAiModelId: input.model,
		planModeOpenAiModelId: input.model,
	}),
}

/** Cline's key is a separate file, so it is a side write rather than part of the config. */
export async function writeClineSecret(apiKey: string): Promise<void> {
	const secrets = (await readJson(CLINE_SECRETS_PATH())) ?? {}
	secrets.openAiApiKey = apiKey
	await fs.mkdir(CLINE_DATA_DIR(), { recursive: true })
	await fs.writeFile(CLINE_SECRETS_PATH(), `${JSON.stringify(secrets, null, 2)}\n`)
}

/** Resetting Cline means handing both modes back to Cline's own provider. */
export async function removeClineSettings(): Promise<void> {
	const state = (await readJson(CLINE_STATE_PATH())) ?? {}
	if (state.actModeApiProvider === "openai") {
		delete state.openAiBaseUrl
		delete state.openAiModelId
		delete state.planModeOpenAiModelId
		state.actModeApiProvider = "cline"
		state.planModeApiProvider = "cline"
	}
	await fs.writeFile(CLINE_STATE_PATH(), `${JSON.stringify(state, null, 2)}\n`)

	const secrets = (await readJson(CLINE_SECRETS_PATH())) ?? {}
	delete secrets.openAiApiKey
	await fs.writeFile(CLINE_SECRETS_PATH(), `${JSON.stringify(secrets, null, 2)}\n`)
}

export { isClineInstalled }
