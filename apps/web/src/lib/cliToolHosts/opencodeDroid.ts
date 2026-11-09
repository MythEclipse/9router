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
 * OpenCode's layout: `provider["9router"]` in `~/.config/opencode/opencode.json`, plus a
 * top-level active `model` and an `agent.explorer` subagent that both name a model.
 *
 * OpenCode keeps models as a *map* keyed by id rather than a list, and it addresses the active
 * one as `9router/<id>`. Three pointers can therefore dangle at once — the provider map, the
 * active model, and the explorer subagent — and removing a model has to deal with all three or
 * OpenCode starts on a model that no longer exists.
 */

const OPENCODE_DIR = () => path.join(os.homedir(), ".config", "opencode")
const OPENCODE_CONFIG_PATH = () => path.join(OPENCODE_DIR(), "opencode.json")
const OPENCODE_PREFIX = "9router/"

type OpenCodeProvider = {
	npm?: string
	options?: { baseURL?: string; apiKey?: string; [key: string]: unknown }
	models?: Record<string, { name?: string; [key: string]: unknown }>
	[key: string]: unknown
}
type OpenCodeConfig = {
	model?: string
	provider?: Record<string, OpenCodeProvider>
	agent?: Record<string, unknown> & { explorer?: { model?: string; [key: string]: unknown } }
	[key: string]: unknown
}

async function isOpenCodeInstalled(): Promise<boolean> {
	try {
		const isWindows = os.platform() === "win32"
		const command = isWindows ? "where opencode" : "which opencode"
		const env = isWindows
			? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
			: process.env
		await execAsync(command, { windowsHide: true, env })
		return true
	} catch {
		try {
			await fs.access(OPENCODE_CONFIG_PATH())
			return true
		} catch {
			return false
		}
	}
}

/** The models a save should carry: the array form, the legacy single string, or neither. */
export function requestedModelsOf(input: { model: string; models?: unknown }): string[] {
	const list = Array.isArray(input.models) ? input.models.filter((m) => typeof m === "string") : []
	return list.length > 0 ? list : input.model ? [input.model] : []
}

export const openCodeSettingsConfig: ToolConfigPort = {
	path: OPENCODE_CONFIG_PATH(),
	read: () => readJson(OPENCODE_CONFIG_PATH()),
	readForWrite: async () =>
		readConfigForWrite(
			fs,
			OPENCODE_CONFIG_PATH(),
			(raw) => JSON.parse(raw) as Record<string, unknown>,
		),
	write: async (text) => {
		await fs.mkdir(OPENCODE_DIR(), { recursive: true })
		await fs.writeFile(OPENCODE_CONFIG_PATH(), text)
	},
	baseUrlSuffix: "with-v1",
	required: ["baseUrl"],
	resolveApiKey: (requested) => resolveCliApiKey(requested || null),
	installKeys: ["9router"],
	storedBaseUrl: (config) => {
		const provider = (config as OpenCodeConfig)?.provider?.["9router"]
		return provider?.options?.baseURL ?? null
	},
	apply: (config, input) => {
		const current = (config as OpenCodeConfig) ?? {}
		const provider = { ...(current.provider ?? {}) }
		const entry: OpenCodeProvider = provider["9router"] ?? {
			npm: "@ai-sdk/openai-compatible",
			options: {},
			models: {},
		}

		const models = { ...(entry.models ?? {}) }
		for (const id of requestedModelsOf(input)) {
			models[id] = {
				name: resolveModelDisplayName(id, undefined),
				modalities: { input: ["text", "image"], output: ["text"] },
			}
		}

		provider["9router"] = {
			...entry,
			options: { ...(entry.options ?? {}), baseURL: input.baseUrl, apiKey: input.apiKey },
			models,
		}

		const first = requestedModelsOf(input)[0]
		const agent = { ...(current.agent ?? {}) }
		if (first) {
			agent.explorer = {
				description: "Fast explorer subagent for codebase exploration",
				mode: "subagent",
				model: `${OPENCODE_PREFIX}${first}`,
			}
		}

		return {
			...current,
			provider,
			// An explicit empty string means "no active model", which is not the same as unset.
			...(typeof input.model === "string" ? { model: first ? `${OPENCODE_PREFIX}${first}` : "" } : {}),
			agent,
		}
	},
	clearActive: (config) => {
		const current = (config as OpenCodeConfig) ?? {}
		// Clearing the pointer keeps the models: the operator wants none selected, not none
		// available.
		if (current.model?.startsWith(OPENCODE_PREFIX)) return { ...current, model: "" }
		return current
	},
	removeModel: (config, modelId) => {
		const current = (config as OpenCodeConfig) ?? {}
		const entry = current.provider?.["9router"]
		if (!entry?.models?.[modelId]) return current

		const models = { ...entry.models }
		delete models[modelId]
		const provider = { ...(current.provider ?? {}) }

		if (Object.keys(models).length === 0) {
			delete provider["9router"]
			const { model: _dropped, ...rest } = current
			return { ...rest, provider }
		}

		provider["9router"] = { ...entry, models }
		const remaining = Object.keys(models)
		return {
			...current,
			provider,
			// Removing the model that was in use has to move the pointer, or OpenCode starts on
			// a model this config no longer offers.
			...(current.model === `${OPENCODE_PREFIX}${modelId}`
				? { model: `${OPENCODE_PREFIX}${remaining[0]}` }
				: {}),
		}
	},
}

/** OpenCode's reset drops the provider, the pointers that name it, and nothing else. */
export async function removeOpenCodeSettings(): Promise<void> {
	const config = (await readJson(OPENCODE_CONFIG_PATH())) as OpenCodeConfig | null
	if (!config) return
	if (config.provider) delete config.provider["9router"]
	if (config.model?.startsWith(OPENCODE_PREFIX)) delete config.model
	if (config.agent?.explorer?.model?.startsWith(OPENCODE_PREFIX)) {
		delete config.agent.explorer
		if (Object.keys(config.agent).length === 0) delete config.agent
	}
	await fs.writeFile(OPENCODE_CONFIG_PATH(), JSON.stringify(config, null, 2))
}

export { isOpenCodeInstalled }

/**
 * Droid's layout: a `customModels` array where the *order* is the configuration.
 *
 * The first entry is the default model, ids are positional (`custom:9Router-<n>`), and the
 * whole array is owned by this screen. Rebuilding rather than merging is therefore correct
 * here — but only for our own entries: anything whose id does not carry our prefix belongs to
 * the operator and has to survive the save.
 */

const DROID_DIR = () => path.join(os.homedir(), ".factory")
const DROID_SETTINGS_PATH = () => path.join(DROID_DIR(), "settings.json")
const DROID_PREFIX = "custom:9Router"

type DroidModel = {
	model: string
	id: string
	index: number
	baseUrl: string
	apiKey: string
	displayName?: string
	maxOutputTokens?: number
	noImageSupport?: boolean
	provider?: string
}
type DroidConfig = { customModels?: DroidModel[]; [key: string]: unknown }

async function isDroidInstalled(): Promise<boolean> {
	try {
		const isWindows = os.platform() === "win32"
		await execAsync(isWindows ? "where droid" : "which droid", { windowsHide: true })
		return true
	} catch {
		try {
			await fs.access(DROID_SETTINGS_PATH())
			return true
		} catch {
			return false
		}
	}
}

export const droidSettingsConfig: ToolConfigPort = {
	path: DROID_SETTINGS_PATH(),
	read: () => readJson(DROID_SETTINGS_PATH()),
	readForWrite: async () =>
		readConfigForWrite(
			fs,
			DROID_SETTINGS_PATH(),
			(raw) => JSON.parse(raw) as Record<string, unknown>,
		),
	write: async (text) => {
		await fs.mkdir(DROID_DIR(), { recursive: true })
		await fs.writeFile(DROID_SETTINGS_PATH(), text)
	},
	baseUrlSuffix: "with-v1",
	required: ["baseUrl"],
	resolveApiKey: (requested) => resolveCliApiKey(requested || null),
	installKeys: [DROID_PREFIX],
	storedBaseUrl: (config) => {
		const ours = ((config as DroidConfig)?.customModels ?? []).find((m) =>
			m.id?.startsWith(DROID_PREFIX),
		)
		return ours?.baseUrl ?? null
	},
	apply: (config, input) => {
		const current = (config as DroidConfig) ?? {}
		const requested = requestedModelsOf(input)
		// Entries we own are rebuilt from the form; everyone else's stay exactly where they were.
		const theirs = (current.customModels ?? []).filter((m) => !m.id?.startsWith(DROID_PREFIX))
		const ours: DroidModel[] = requested.map((model, index) => ({
			model,
			id: `${DROID_PREFIX}-${index}`,
			index,
			baseUrl: input.baseUrl,
			apiKey: input.apiKey || "your_api_key",
			displayName: resolveModelDisplayName(model, undefined),
			maxOutputTokens: 131072,
			noImageSupport: false,
			provider: "openai",
		}))
		return { ...current, customModels: [...ours, ...theirs] }
	},
}

/** Droid's reset removes only the entries this screen created. */
export async function removeDroidSettings(): Promise<void> {
	const config = (await readJson(DROID_SETTINGS_PATH())) as DroidConfig | null
	if (!config?.customModels) return
	config.customModels = config.customModels.filter((m) => !m.id?.startsWith(DROID_PREFIX))
	await fs.writeFile(DROID_SETTINGS_PATH(), JSON.stringify(config, null, 2))
}

export { isDroidInstalled }
