import { exec } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import type { ToolConfigPort } from "9router-api/application/cli-tools/manage-tool-settings"
import type {
	DevinInstallPort,
	DevinVersionPort,
} from "9router-api/application/cli-tools/read-devin-status"
import {
	isWritableApiKey,
	type ModelEntry,
	mergeModelEntries,
} from "9router-api/domain/cli-tool-settings"
import { devinBinCandidates } from "9router-api/domain/devin-binary"
import {
	applyGrokBuildConfig,
	GROK_MAIN_MODEL_SLOT,
	parseGrokBuildConfig,
	resetGrokBuildConfig,
} from "9router-api/domain/grok-build-config"
import {
	JCODE_KEY_ENV,
	jcodeHasThisInstall,
	withJcodeProvider,
} from "9router-api/domain/jcode-config"
import {
	OMP_PROVIDER_ID,
	ompHasThisInstall,
	withOmpProvider,
} from "9router-api/domain/omp-models-yml"
import { parseTOML, stringifyTOML } from "confbox"
import { getCapabilitiesForModel } from "open-sse/providers/capabilities"
import { resolveCliApiKey } from "@/app/api/cli-tools/resolveApiKey"
import { resolveModelDisplayName } from "@/shared/utils/modelDisplayName"
import { readConfigForWrite } from "../cliTools/configWrite"

import {
	execAsync,
	KILO_AUTH_PATH,
	KILO_DATA_DIR,
	readJson,
	VSCODE_SETTINGS_PATH,
} from "./shared.ts"

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
	readForWrite: () =>
		readConfigForWrite(fs, KILO_AUTH_PATH(), (raw) => JSON.parse(raw) as Record<string, unknown>),
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
	readForWrite: () =>
		readConfigForWrite(fs, CLINE_STATE_PATH(), (raw) => JSON.parse(raw) as Record<string, unknown>),
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

/**
 * Smelt's own layout: one flat `config.json` where this screen owns exactly four keys.
 *
 * Everything else in the file belongs to the operator, which is why the reset removes those
 * four keys and deletes the file only when nothing else is left. `_managedBy` is what lets a
 * later read tell "configured by this screen" from "someone typed a base URL that happens to
 * be localhost".
 */

const SMELT_CONFIG_PATH = () => path.join(os.homedir(), ".smelt", "config.json")

const SMELT_KEYS = ["baseUrl", "apiKey", "model", "_managedBy"] as const

async function isSmeltInstalled(): Promise<boolean> {
	try {
		const isWindows = os.platform() === "win32"
		await execAsync(isWindows ? "where smelt" : "which smelt", { windowsHide: true })
		return true
	} catch {
		try {
			await fs.access(SMELT_CONFIG_PATH())
			return true
		} catch {
			return false
		}
	}
}

export const smeltSettingsConfig: ToolConfigPort = {
	path: SMELT_CONFIG_PATH(),
	read: () => readJson(SMELT_CONFIG_PATH()),
	readForWrite: () =>
		readConfigForWrite(fs, SMELT_CONFIG_PATH(), (raw) => JSON.parse(raw) as Record<string, unknown>),
	write: async (text) => {
		await fs.mkdir(path.dirname(SMELT_CONFIG_PATH()), { recursive: true })
		await fs.writeFile(SMELT_CONFIG_PATH(), text, "utf-8")
	},
	baseUrlSuffix: "with-v1",
	installKeys: SMELT_KEYS,
	storedBaseUrl: (config) => {
		if (config?._managedBy === "9router") return "9router"
		return typeof config?.baseUrl === "string" ? config.baseUrl : null
	},
	apply: (config, input) => ({
		...config,
		baseUrl: input.baseUrl,
		apiKey: input.apiKey,
		// A model the operator already chose is kept when the form leaves it blank.
		model: input.model || (config.model as string) || "provider/model-id",
		_managedBy: "9router",
	}),
}

export { isSmeltInstalled }
