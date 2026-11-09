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

import { execAsync, readJson } from "./shared.ts"

/**
 * Crush's layout: `providers["9router"]` in a shared `crush.json`.
 *
 * Crush stores the key inside the provider block rather than in a secret store, and it keeps
 * providers for tools the operator added themselves, so the write replaces one entry and the
 * reset removes one entry. Deleting the whole file would take those other providers with it.
 */

const CRUSH_CONFIG_DIR = () =>
	path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "crush")
const CRUSH_CONFIG_PATH = () => path.join(CRUSH_CONFIG_DIR(), "crush.json")

type CrushProvider = { base_url?: string; api_key?: string }
type CrushConfig = { providers?: Record<string, CrushProvider> }

async function isCrushInstalled(): Promise<boolean> {
	try {
		const isWindows = os.platform() === "win32"
		await execAsync(isWindows ? "where crush" : "which crush", { windowsHide: true })
		return true
	} catch {
		try {
			await fs.access(CRUSH_CONFIG_PATH())
			return true
		} catch {
			return false
		}
	}
}

export const crushSettingsConfig: ToolConfigPort = {
	path: CRUSH_CONFIG_PATH(),
	read: () => readJson(CRUSH_CONFIG_PATH()),
	readForWrite: async () => {
		const config = (await readConfigForWrite(
			fs,
			CRUSH_CONFIG_PATH(),
			(raw) => JSON.parse(raw) as Record<string, unknown>,
		)) as CrushConfig
		return config as Record<string, unknown>
	},
	write: async (text) => {
		await fs.mkdir(CRUSH_CONFIG_DIR(), { recursive: true })
		await fs.writeFile(CRUSH_CONFIG_PATH(), text, "utf-8")
	},
	baseUrlSuffix: "with-v1",
	installKeys: ["9router"],
	storedBaseUrl: (config) => {
		const provider = (config as CrushConfig)?.providers?.["9router"]
		return provider?.base_url ?? null
	},
	apply: (config, input) => {
		const current = config as CrushConfig
		const providers = { ...(current.providers ?? {}) }
		const modelId = input.model || "provider/model-id"
		providers["9router"] = {
			...(providers["9router"] ?? {}),
			type: "openai-compat" as never,
			base_url: input.baseUrl,
			api_key: input.apiKey,
			models: [{ id: modelId, name: modelId, context_window: 128000 }],
		} as never
		return { ...current, providers }
	},
}

/** Crush's reset removes only its own provider entry, and the map only when it is empty. */
export async function removeCrushSettings(): Promise<void> {
	const config = ((await readJson(CRUSH_CONFIG_PATH())) ?? {}) as CrushConfig
	if (!config.providers?.["9router"]) return
	delete config.providers["9router"]
	if (Object.keys(config.providers).length === 0) delete config.providers
	await fs.writeFile(CRUSH_CONFIG_PATH(), `${JSON.stringify(config, null, 2)}\n`, "utf-8")
}

export { isCrushInstalled }

/**
 * Pi's layout: `providers["9router"]` in `models.json`, with a model list.
 *
 * Pi writes models as objects with context limits, and the operator edits those by hand —
 * so the write merges over the models it finds instead of replacing them. Path resolution
 * matters too: Pi reads `~/.pi/agent/models.json` when that directory exists and
 * `~/.pi/models.json` otherwise, and writing the file Pi does not read means the screen
 * reports success while nothing changes.
 */

const PI_AGENT_PATH = () => path.join(os.homedir(), ".pi", "agent", "models.json")
const PI_ROOT_PATH = () => path.join(os.homedir(), ".pi", "models.json")

async function resolvePiModelsJsonPath(): Promise<string> {
	try {
		await fs.mkdir(path.dirname(PI_AGENT_PATH()), { recursive: true })
		return PI_AGENT_PATH()
	} catch {
		return PI_ROOT_PATH()
	}
}

type PiConfig = { providers?: Record<string, Record<string, unknown>> }

async function isPiInstalled(): Promise<boolean> {
	// Either location counts: Pi reads the agent file when that directory exists and the root
	// file otherwise, so a config at either path is a Pi that has been run.
	for (const candidate of [PI_AGENT_PATH(), PI_ROOT_PATH()]) {
		try {
			await fs.access(candidate)
			return true
		} catch {
			// try the next location
		}
	}
	try {
		const isWindows = os.platform() === "win32"
		await execAsync(isWindows ? "where pi" : "which pi", { windowsHide: true })
		return true
	} catch {
		return false
	}
}

export const piSettingsConfig: ToolConfigPort = {
	get path() {
		return PI_AGENT_PATH()
	},
	read: async () => {
		const configPath = await resolvePiModelsJsonPath()
		return readJson(configPath)
	},
	readForWrite: async () => {
		const configPath = await resolvePiModelsJsonPath()
		return readConfigForWrite(fs, configPath, (raw) => JSON.parse(raw) as Record<string, unknown>)
	},
	write: async (text) => {
		const configPath = await resolvePiModelsJsonPath()
		await fs.mkdir(path.dirname(configPath), { recursive: true })
		await fs.writeFile(configPath, text, "utf-8")
	},
	baseUrlSuffix: "with-v1",
	required: ["baseUrl"],
	resolveApiKey: (requested) => resolveCliApiKey(requested || null),
	installKeys: ["9router"],
	storedBaseUrl: (config) => {
		const provider = (config as PiConfig)?.providers?.["9router"]
		return typeof provider?.baseUrl === "string" ? provider.baseUrl : null
	},
	apply: (config, input) => {
		const current = config as PiConfig
		const providers = { ...(current.providers ?? {}) }
		const existing = providers["9router"] ?? {}
		const models: ModelEntry[] = mergeModelEntries(
			existing.models,
			Array.isArray(input.models) && input.models.length > 0 ? input.models : [input.model],
			resolveModelDisplayName,
		)
		providers["9router"] = {
			...existing,
			baseUrl: input.baseUrl,
			// A placeholder is not a key: keep the stored one rather than write a value that
			// every request will reject.
			apiKey: isWritableApiKey(input.apiKey ?? "") ? input.apiKey : existing.apiKey,
			api: existing.api ?? "openai-completions",
			models,
		}
		return { ...current, providers }
	},
}

/** Pi's reset removes only its own provider entry, and the map only when it is empty. */
export async function removePiSettings(): Promise<void> {
	const configPath = await resolvePiModelsJsonPath()
	const config = ((await readJson(configPath)) ?? {}) as PiConfig
	if (!config.providers?.["9router"]) return
	delete config.providers["9router"]
	if (Object.keys(config.providers).length === 0) delete config.providers
	await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8")
}

export { isPiInstalled, resolvePiModelsJsonPath }
