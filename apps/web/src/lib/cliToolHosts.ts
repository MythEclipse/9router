import { exec } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import type { ToolConfigPort } from "9router-api/application/cli-tools/manage-tool-settings"
import {
	isWritableApiKey,
	type ModelEntry,
	mergeModelEntries,
} from "9router-api/domain/cli-tool-settings"
import {
	applyGrokBuildConfig,
	GROK_MAIN_MODEL_SLOT,
	parseGrokBuildConfig,
	resetGrokBuildConfig,
} from "9router-api/domain/grok-build-config"
import {
	OMP_PROVIDER_ID,
	ompHasThisInstall,
	withOmpProvider,
} from "9router-api/domain/omp-models-yml"
import { parseTOML, stringifyTOML } from "confbox"
import { getCapabilitiesForModel } from "open-sse/providers/capabilities"
import { resolveCliApiKey } from "@/app/api/cli-tools/resolveApiKey"
import { resolveModelDisplayName } from "@/shared/utils/modelDisplayName"
import { readConfigForWrite } from "./cliTools/configWrite"

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

/** The file's text, or null when there is no file — the raw form `readForWrite` needs. */
async function readText(filePath: string): Promise<string | null> {
	try {
		return await fs.readFile(filePath, "utf-8")
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

/**
 * A TOML config with one `[openai]` table and a "managed by" header.
 *
 * CodeWhale and ForgeCode are the same shape down to the table name and the header comment, so
 * they share one implementation: two copies would drift apart the first time either tool
 * changes a key, and the screen would keep writing the old spelling to one of them.
 *
 * `readForWrite` rethrows on an unparseable file rather than answering `{}`, because a merge
 * that starts from an empty object silently drops every other table the operator had.
 */
function openAiTomlConfig(options: {
	readonly dir: () => string
	readonly file: string
	readonly header: string
	readonly binary: string
	readonly toolName: string
}): ToolConfigPort {
	const configPath = () => path.join(options.dir(), options.file)
	return {
		path: configPath(),
		read: async () => {
			const raw = await readText(configPath())
			if (raw === null) return null
			try {
				return (parseTOML(raw) ?? {}) as Record<string, unknown>
			} catch {
				return null
			}
		},
		readForWrite: async () =>
			readConfigForWrite(fs, configPath(), (raw) => (parseTOML(raw) ?? {}) as Record<string, unknown>),
		write: async (text) => {
			await fs.mkdir(options.dir(), { recursive: true })
			await fs.writeFile(configPath(), text, "utf-8")
		},
		format: "toml",
		serialise: (config) => `${options.header}\n\n${stringifyTOML(config)}`,
		baseUrlSuffix: "with-v1",
		installKeys: ["openai"],
		storedBaseUrl: (config) => {
			const openai = (config as { openai?: Record<string, unknown> }).openai
			return typeof openai?.base_url === "string" ? openai.base_url : null
		},
		apply: (config, input) => ({
			...(config as Record<string, unknown>),
			openai: {
				api_key: input.apiKey,
				base_url: input.baseUrl,
				model: input.model || "provider/model-id",
			},
		}),
	}
}

/**
 * CodeWhale's layout: `[openai]` in a TOML file, with every other table re-written untouched.
 *
 * This is the first TOML tool here, so the host supplies both halves of the format — the
 * parser used by `readForWrite` and the serialiser used on write — because a file written as
 * TOML but parsed as JSON reads back as garbage the moment the tool next loads it.
 */

const CODEWHALE_CONFIG_DIR = () => path.join(os.homedir(), ".codewhale")
const CODEWHALE_CONFIG_PATH = () => path.join(CODEWHALE_CONFIG_DIR(), "config.toml")

export const codewhaleSettingsConfig: ToolConfigPort = openAiTomlConfig({
	dir: CODEWHALE_CONFIG_DIR,
	file: "config.toml",
	header: "# CodeWhale config - managed by 9Router",
	binary: "codewhale",
	toolName: "CodeWhale",
})

/** CodeWhale's reset drops the table, and the file only when no other table remains. */
export async function removeCodewhaleSettings(): Promise<void> {
	await removeOpenAiTomlTable(CODEWHALE_CONFIG_PATH())
}

export const isCodewhaleInstalled = () => detectInstall("codewhale", CODEWHALE_CONFIG_PATH())

/**
 * OpenClaw's layout: a nested `openclaw.json` plus a `models.json` inside every agent folder.
 *
 * Three things here are OpenClaw's own rules rather than this screen's: the default model is
 * addressed as `9router/<id>`, the allowlist under `agents.defaults.models` has to be pruned
 * of stale `9router/*` keys or OpenClaw refuses the model it is told to use, and each agent
 * with its own directory reads that directory's `models.json` in preference to the shared one.
 * Writing only the shared file leaves those agents pointing at a provider block that no longer
 * matches, which is why the per-agent files are written in a side write.
 */

const OPENCLAW_DIR = () => path.join(os.homedir(), ".openclaw")
const OPENCLAW_SETTINGS_PATH = () => path.join(OPENCLAW_DIR(), "openclaw.json")
const OPENCLAW_PREFIX = "9router/"

type OpenClawProvider = {
	baseUrl?: string
	apiKey?: string
	api?: string
	models?: Array<{ id?: string; name?: string }>
}
type OpenClawAgent = { id?: string; agentDir?: string; model?: unknown }
type OpenClawConfig = {
	models?: { providers?: Record<string, OpenClawProvider> }
	agents?: {
		defaults?: { model?: { primary?: string }; models?: Record<string, unknown> }
		list?: OpenClawAgent[]
	}
}

async function isOpenClawInstalled(): Promise<boolean> {
	try {
		const isWindows = os.platform() === "win32"
		const command = isWindows ? "where openclaw" : "which openclaw"
		const env = isWindows
			? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
			: process.env
		await execAsync(command, { windowsHide: true, env })
		return true
	} catch {
		try {
			await fs.access(OPENCLAW_SETTINGS_PATH())
			return true
		} catch {
			return false
		}
	}
}

export const openclawSettingsConfig: ToolConfigPort = {
	path: OPENCLAW_SETTINGS_PATH(),
	read: () => readJson(OPENCLAW_SETTINGS_PATH()),
	readForWrite: async () =>
		readConfigForWrite(
			fs,
			OPENCLAW_SETTINGS_PATH(),
			(raw) => JSON.parse(raw) as Record<string, unknown>,
		),
	write: async (text) => {
		await fs.mkdir(OPENCLAW_DIR(), { recursive: true })
		await fs.writeFile(OPENCLAW_SETTINGS_PATH(), text)
	},
	baseUrlSuffix: "with-v1",
	required: ["baseUrl", "model"],
	installKeys: ["9router"],
	storedBaseUrl: (config) => {
		const provider = (config as OpenClawConfig)?.models?.providers?.["9router"]
		return provider?.baseUrl ?? null
	},
	apply: (config, input) => {
		const current = (config as OpenClawConfig) ?? {}
		const agents = { ...(current.agents ?? {}) }
		const defaults = { ...(agents.defaults ?? {}) }
		const allowlist = { ...(defaults.models ?? {}) }
		const model = { ...(defaults.model ?? {}) }
		const providerModels = { ...(current.models?.providers ?? {}) }

		// Stale 9router entries have to go, or OpenClaw offers models that no longer resolve.
		for (const key of Object.keys(allowlist)) {
			if (key.startsWith(OPENCLAW_PREFIX)) delete allowlist[key]
		}
		model.primary = `${OPENCLAW_PREFIX}${input.model}`

		const allModels = new Set<string>([input.model])
		for (const override of Object.values(input.agentModels ?? {})) {
			if (override) allModels.add(override)
		}
		for (const id of allModels) allowlist[`${OPENCLAW_PREFIX}${id}`] = {}

		const list = (agents.list ?? []).map((agent) => {
			const assigned = agent.id ? input.agentModels?.[agent.id] : undefined
			if (assigned) return { ...agent, model: `${OPENCLAW_PREFIX}${assigned}` }
			// An agent still pointing at our provider but with no override would keep a model
			// that the allowlist above just pruned; hand it back to the default instead.
			if (typeof agent.model === "string" && agent.model.startsWith(OPENCLAW_PREFIX)) {
				const { model: _dropped, ...rest } = agent
				return rest
			}
			return agent
		})

		providerModels["9router"] = {
			baseUrl: input.baseUrl,
			apiKey: input.apiKey || "your_api_key",
			api: "openai-completions",
			models: [...allModels].map((id) => ({ id, name: resolveModelDisplayName(id, undefined) })),
		}

		return {
			...current,
			models: { ...(current.models ?? {}), providers: providerModels },
			agents: {
				...agents,
				defaults: { ...defaults, model, models: allowlist },
				...(agents.list ? { list } : {}),
			},
		}
	},
}

/**
 * Writes each agent's own `models.json`, which OpenClaw reads in preference to the shared one.
 *
 * Best effort: an agent directory that cannot be written should not fail the save, because the
 * shared config is already correct and the agent will fall back to it.
 */
export async function writeOpenClawAgentModels(input: {
	baseUrl: string
	apiKey?: string
	model: string
	agentModels?: Record<string, string>
}): Promise<void> {
	const config = ((await readJson(OPENCLAW_SETTINGS_PATH())) ?? {}) as OpenClawConfig
	for (const agent of config.agents?.list ?? []) {
		if (!agent.agentDir) continue
		const assigned = agent.id ? input.agentModels?.[agent.id] : undefined
		const modelId = assigned || input.model
		const modelsPath = path.join(agent.agentDir, "models.json")
		const existing = ((await readJson(modelsPath)) ?? {}) as {
			providers?: Record<string, OpenClawProvider>
		}
		const providers = { ...(existing.providers ?? {}) }
		providers["9router"] = {
			baseUrl: input.baseUrl,
			apiKey: input.apiKey || "your_api_key",
			api: "openai-completions",
			models: [{ id: modelId, name: resolveModelDisplayName(modelId, undefined) }],
		}
		await fs.mkdir(agent.agentDir, { recursive: true })
		await fs.writeFile(modelsPath, JSON.stringify({ ...existing, providers }, null, 2))
	}
}

/** OpenClaw's reset hands its default model back and drops the provider block. */
export async function removeOpenClawSettings(): Promise<void> {
	const config = (await readJson(OPENCLAW_SETTINGS_PATH())) as OpenClawConfig | null
	if (!config) return
	if (config.models?.providers) {
		delete config.models.providers["9router"]
		if (Object.keys(config.models.providers).length === 0) delete config.models.providers
	}
	const defaults = config.agents?.defaults
	if (defaults?.models) {
		for (const key of Object.keys(defaults.models)) {
			if (key.startsWith(OPENCLAW_PREFIX)) delete defaults.models[key]
		}
	}
	if (defaults?.model?.primary?.startsWith(OPENCLAW_PREFIX)) delete defaults.model.primary
	await fs.writeFile(OPENCLAW_SETTINGS_PATH(), JSON.stringify(config, null, 2))
}

export { isOpenClawInstalled }

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
function requestedModelsOf(input: { model: string; models?: unknown }): string[] {
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

/**
 * Codex's layout: `~/.codex/config.toml` plus `~/.codex/auth.json`.
 *
 * Two details decide whether the generated config works at all:
 *
 * - a *custom* provider ignores `auth.json`, so the key must travel as a static
 *   `Authorization` header in `http_headers`. Putting it in `auth.json` looks tidier and
 *   authenticates nothing.
 * - confbox writes a *nested* object as a TOML section (`[model_providers.9router]`), but a
 *   key that already contains a dot as a quoted assignment (`["model_providers.9router"]`).
 *   Only the nested form is the section Codex reads, so the config is kept nested.
 */

const CODEX_DIR = () => path.join(os.homedir(), ".codex")
const CODEX_CONFIG_PATH = () => path.join(CODEX_DIR(), "config.toml")
const CODEX_AUTH_PATH = () => path.join(CODEX_DIR(), "auth.json")

async function isCodexInstalled(): Promise<boolean> {
	try {
		const isWindows = os.platform() === "win32"
		await execAsync(isWindows ? "where codex" : "which codex", { windowsHide: true })
		return true
	} catch {
		try {
			await fs.access(CODEX_CONFIG_PATH())
			return true
		} catch {
			return false
		}
	}
}

export const codexSettingsConfig: ToolConfigPort = {
	path: CODEX_CONFIG_PATH(),
	read: async () => {
		const raw = await readText(CODEX_CONFIG_PATH())
		if (raw === null) return null
		try {
			return (parseTOML(raw) ?? {}) as Record<string, unknown>
		} catch {
			return null
		}
	},
	readForWrite: async () => {
		const raw = await readText(CODEX_CONFIG_PATH())
		if (raw === null) return {}
		try {
			return (parseTOML(raw) ?? {}) as Record<string, unknown>
		} catch {
			throw new Error("Existing config could not be parsed. Refusing to overwrite it")
		}
	},
	write: async (text) => {
		await fs.mkdir(CODEX_DIR(), { recursive: true })
		await fs.writeFile(CODEX_CONFIG_PATH(), text)
	},
	format: "toml",
	serialise: (config) => stringifyTOML(config),
	baseUrlSuffix: "with-v1",
	installKeys: ["9router"],
	storedBaseUrl: (config) => {
		const providers = (config as { model_providers?: Record<string, { base_url?: string }> })
			.model_providers
		return providers?.["9router"]?.base_url ?? null
	},
	apply: (config, input) => {
		const next = { ...config }
		next.model = input.model
		next.model_provider = "9router"

		const providers = { ...((next.model_providers as Record<string, unknown>) ?? {}) }
		providers["9router"] = {
			name: "9Router",
			base_url: input.baseUrl,
			wire_api: "responses",
			// A custom provider ignores auth.json; the key has to be a static header.
			http_headers: { Authorization: `Bearer ${input.apiKey}` },
		}
		next.model_providers = providers

		// `agents.subagent` was a role in an earlier layout; the current key is a scalar.
		const agents = { ...((next.agents as Record<string, unknown>) ?? {}) }
		delete agents.subagent
		agents.default_subagent_model = input.model
		next.agents = agents
		return next
	},
}

/** Codex's reset also clears the token it may have written into `auth.json`. */
export async function removeCodexSettings(): Promise<void> {
	const raw = await readText(CODEX_CONFIG_PATH())
	if (raw !== null) {
		try {
			const config = (parseTOML(raw) ?? {}) as Record<string, unknown>
			if (config.model_provider === "9router") {
				delete config.model
				delete config.model_provider
			}
			const providers = (config.model_providers as Record<string, unknown> | undefined) ?? {}
			delete providers["9router"]
			if (Object.keys(providers).length === 0) delete config.model_providers
			else config.model_providers = providers
			const agents = (config.agents as Record<string, unknown> | undefined) ?? {}
			delete agents.default_subagent_model
			delete agents.subagent
			if (Object.keys(agents).length === 0) delete config.agents
			else config.agents = agents
			await fs.writeFile(CODEX_CONFIG_PATH(), stringifyTOML(config))
		} catch {
			// An unparseable config is left alone rather than replaced.
		}
	}

	const authPath = CODEX_AUTH_PATH()
	const authRaw = await readText(authPath)
	if (authRaw === null) return
	try {
		const auth = JSON.parse(authRaw) as Record<string, unknown>
		delete auth.OPENAI_API_KEY
		delete auth.auth_mode
		if (Object.keys(auth).length === 0) await fs.rm(authPath, { force: true })
		else await fs.writeFile(authPath, `${JSON.stringify(auth, null, 2)}\n`)
	} catch {
		// A corrupt auth file is not ours to rewrite.
	}
}

export { isCodexInstalled }

/**
 * GitHub Copilot's layout: VS Code's `chatLanguageModels.json`, an array of vendor entries.
 *
 * Two details are Copilot's, not this screen's:
 *
 * - the entry must be marked `vendor: "azure"`, because VS Code routes by vendor and an
 *   OpenAI-compatible endpoint without that marker is offered as nothing;
 * - the model URL carries a `#models.ai.azure.com` fragment, which is how VS Code decides to
 *   send an `api-key` header instead of a bearer token. Dropping it authenticates wrongly.
 *
 * The array is shared with entries the operator added in VS Code, so a save replaces ours and
 * appends when there is none — it never rebuilds the array.
 */

const COPILOT_CONFIG_PATH = () => {
	const home = os.homedir()
	if (os.platform() === "win32") {
		return path.join(process.env.APPDATA || home, "Code", "User", "chatLanguageModels.json")
	}
	if (os.platform() === "darwin") {
		return path.join(
			home,
			"Library",
			"Application Support",
			"Code",
			"User",
			"chatLanguageModels.json",
		)
	}
	return path.join(home, ".config", "Code", "User", "chatLanguageModels.json")
}

const COPILOT_ENTRY_NAME = "9Router"
const AZURE_ROUTE_FRAGMENT = "#models.ai.azure.com"

type CopilotModel = {
	id: string
	name: string
	url: string
	toolCalling: boolean
	vision: boolean
	maxInputTokens: number
	maxOutputTokens: number
}
type CopilotEntry = {
	name: string
	vendor: string
	apiKey: string
	models: CopilotModel[]
}

async function isCopilotInstalled(): Promise<boolean> {
	try {
		const isWindows = os.platform() === "win32"
		await execAsync(isWindows ? "where code" : "which code", { windowsHide: true })
		return true
	} catch {
		try {
			await fs.access(COPILOT_CONFIG_PATH())
			return true
		} catch {
			return false
		}
	}
}

export const copilotSettingsConfig: ToolConfigPort = {
	path: COPILOT_CONFIG_PATH(),
	read: () => readJson(COPILOT_CONFIG_PATH()),
	readForWrite: async () =>
		readConfigForWrite(fs, COPILOT_CONFIG_PATH(), (raw) => {
			const parsed = JSON.parse(raw) as unknown
			// The file is an array; anything else is not a config this screen understands.
			return Array.isArray(parsed) ? { entries: parsed } : { entries: [] }
		}),
	write: async (text) => {
		const parsed = JSON.parse(text) as { entries?: unknown }
		await fs.mkdir(path.dirname(COPILOT_CONFIG_PATH()), { recursive: true })
		await fs.writeFile(COPILOT_CONFIG_PATH(), JSON.stringify(parsed.entries ?? [], null, 2))
	},
	baseUrlSuffix: "with-v1",
	required: ["baseUrl"],
	resolveApiKey: (requested) => resolveCliApiKey(requested || null),
	installKeys: [COPILOT_ENTRY_NAME],
	storedBaseUrl: (config) => {
		const entries = (config as { entries?: CopilotEntry[] }).entries ?? []
		const ours = entries.find((entry) => entry.name === COPILOT_ENTRY_NAME)
		const url = ours?.models?.[0]?.url
		if (!url) return null
		return url.split(AZURE_ROUTE_FRAGMENT)[0]?.replace(/\/chat\/completions$/, "") ?? null
	},
	apply: (config, input) => {
		const entries = ((config as { entries?: CopilotEntry[] }).entries ?? []).slice()
		const endpoint = `${input.baseUrl}/chat/completions${AZURE_ROUTE_FRAGMENT}`
		const models = requestedModelsOf(input)
		const entry: CopilotEntry = {
			name: COPILOT_ENTRY_NAME,
			vendor: "azure",
			apiKey: input.apiKey,
			models: models.map((id) => ({
				id,
				name: resolveModelDisplayName(id, undefined),
				url: endpoint,
				toolCalling: true,
				vision: false,
				maxInputTokens: 128000,
				maxOutputTokens: 16000,
			})),
		}
		const index = entries.findIndex((existing) => existing.name === COPILOT_ENTRY_NAME)
		if (index >= 0) entries[index] = entry
		else entries.push(entry)
		return { ...(config as Record<string, unknown>), entries }
	},
}

/** Copilot's reset removes only its own entry from the shared array. */
export async function removeCopilotSettings(): Promise<void> {
	const entries = ((await readJson(COPILOT_CONFIG_PATH())) as { entries?: CopilotEntry[] } | null)
		?.entries
	if (!entries) return
	const kept = entries.filter((entry) => entry.name !== COPILOT_ENTRY_NAME)
	if (kept.length === entries.length) return
	await fs.writeFile(COPILOT_CONFIG_PATH(), JSON.stringify(kept, null, 2))
}

export { isCopilotInstalled }

/** Is the tool's binary on PATH, or does its config already exist? */
async function detectInstall(binary: string, configPath: string): Promise<boolean> {
	try {
		const isWindows = os.platform() === "win32"
		await execAsync(isWindows ? `where ${binary}` : `which ${binary}`, { windowsHide: true })
		return true
	} catch {
		try {
			await fs.access(configPath)
			return true
		} catch {
			return false
		}
	}
}

/** Drops the `[openai]` table, and the file only when no other table remains. */
async function removeOpenAiTomlTable(configPath: string): Promise<void> {
	const raw = await readText(configPath)
	if (raw === null) return
	let config: Record<string, unknown>
	try {
		config = (parseTOML(raw) ?? {}) as Record<string, unknown>
	} catch {
		return
	}
	delete config.openai
	if (Object.keys(config).length === 0) {
		await fs.rm(configPath, { force: true })
		return
	}
	await fs.writeFile(configPath, stringifyTOML(config), "utf-8")
}

const FORGE_DIR = () => path.join(os.homedir(), ".forge")
const FORGE_CONFIG_PATH = () => path.join(FORGE_DIR(), "config.toml")

export const forgeSettingsConfig: ToolConfigPort = {
	...openAiTomlConfig({
		dir: FORGE_DIR,
		file: "config.toml",
		header: "# Forge config - managed by 9Router",
		binary: "forge",
		toolName: "ForgeCode",
	}),
	resolveApiKey: (requested) => resolveCliApiKey(requested || null),
}

/** ForgeCode's reset drops its table and keeps every other one. */
export async function removeForgeSettings(): Promise<void> {
	await removeOpenAiTomlTable(FORGE_CONFIG_PATH())
}

export const isForgeInstalled = () => detectInstall("forge", FORGE_CONFIG_PATH())

/**
 * Grok Build's layout: `~/.grok/config.toml` where this screen owns `[models]` slots only.
 *
 * Unlike the other TOML tools, the editing rules live in `domain/grok-build-config.ts`: the
 * file is rewritten by matching sections, existing defaults are remembered in `# 9router-prev-*`
 * comments so a reset can restore them, and only the slots this screen created are touched.
 * The host supplies the file and the selected model's context window.
 */

const GROK_DIR = () => path.join(os.homedir(), ".grok")
const GROK_CONFIG_PATH = () => path.join(GROK_DIR(), "config.toml")

export const isGrokBuildInstalled = async (): Promise<boolean> => {
	try {
		const isWindows = os.platform() === "win32"
		await execAsync(isWindows ? "where grok" : "which grok", { windowsHide: true })
		return true
	} catch {
		try {
			await fs.access(GROK_CONFIG_PATH())
			return true
		} catch {
			try {
				await fs.access(path.join(GROK_DIR(), "bin", "grok"))
				return true
			} catch {
				return false
			}
		}
	}
}

/** The context window Grok Build should record for a model this install serves. */
function contextWindowFor(model: string): number {
	const slash = model.indexOf("/")
	const provider = slash > 0 ? model.slice(0, slash) : null
	const modelId = slash > 0 ? model.slice(slash + 1) : model
	return getCapabilitiesForModel(provider, modelId).contextWindow
}

export const grokBuildSettingsConfig: ToolConfigPort = {
	path: GROK_CONFIG_PATH(),
	read: async () => {
		const raw = await readText(GROK_CONFIG_PATH())
		return raw === null ? null : { toml: raw }
	},
	readForWrite: async () => {
		const raw = await readText(GROK_CONFIG_PATH())
		return { toml: raw ?? "" }
	},
	write: async (text) => {
		await fs.mkdir(GROK_DIR(), { recursive: true })
		// The value stored here is already TOML, produced by the domain rules below.
		await fs.writeFile(GROK_CONFIG_PATH(), JSON.parse(text).toml ?? "")
	},
	baseUrlSuffix: "with-v1",
	required: ["baseUrl", "model"],
	installKeys: [GROK_MAIN_MODEL_SLOT],
	storedBaseUrl: (config) => {
		const toml = (config as { toml?: string })?.toml
		if (!toml) return null
		const main = parseGrokBuildConfig(toml).model
		return typeof main?.base_url === "string" ? main.base_url : null
	},
	apply: (config, input) => {
		const toml = (config as { toml?: string })?.toml ?? ""
		return {
			toml: applyGrokBuildConfig(toml, {
				baseUrl: input.baseUrl,
				apiKey: input.apiKey,
				model: input.model,
				contextWindow: contextWindowFor(input.model),
				subagentModels: undefined,
			}),
		}
	},
}

export const removeGrokBuildSettings = async (): Promise<void> => {
	const raw = await readText(GROK_CONFIG_PATH())
	if (raw === null) return
	await fs.writeFile(GROK_CONFIG_PATH(), resetGrokBuildConfig(raw))
}

/**
 * Oh My Pi's layout: `~/.omp/agent/models.yml` plus an `agent.db` credential row.
 *
 * The YAML is the primary config and the database row is a convenience OMP reads for its own
 * provider list, so the database write is best effort: a missing `better-sqlite3` must not fail
 * a save that already produced a correct `models.yml`.
 */

const OMP_AGENT_DIR = () => path.join(os.homedir(), ".omp", "agent")
const OMP_DB_PATH = () => path.join(OMP_AGENT_DIR(), "agent.db")
const OMP_YML_PATH = () => path.join(OMP_AGENT_DIR(), "models.yml")

export const isOmpInstalled = async (): Promise<boolean> => {
	try {
		const isWindows = os.platform() === "win32"
		await execAsync(isWindows ? "where omp" : "which omp", { windowsHide: true })
		return true
	} catch {
		for (const candidate of [OMP_DB_PATH(), OMP_YML_PATH()]) {
			try {
				await fs.access(candidate)
				return true
			} catch {
				// keep probing
			}
		}
		return false
	}
}

export const ompSettingsConfig: ToolConfigPort = {
	path: OMP_YML_PATH(),
	read: async () => {
		const raw = await readText(OMP_YML_PATH())
		return raw === null ? null : { yaml: raw }
	},
	readForWrite: async () => {
		const raw = await readText(OMP_YML_PATH())
		return { yaml: raw ?? "" }
	},
	write: async (text) => {
		await fs.mkdir(OMP_AGENT_DIR(), { recursive: true })
		await fs.writeFile(OMP_YML_PATH(), JSON.parse(text).yaml ?? "", "utf-8")
	},
	baseUrlSuffix: "with-v1",
	required: ["baseUrl"],
	resolveApiKey: (requested) => resolveCliApiKey(requested || null),
	installKeys: [OMP_PROVIDER_ID],
	storedBaseUrl: (config) => {
		const yaml = (config as { yaml?: string })?.yaml
		return ompHasThisInstall(yaml ?? "") ? "9router" : null
	},
	apply: (config, input) => ({
		yaml: withOmpProvider((config as { yaml?: string })?.yaml ?? "", input.baseUrl, input.apiKey),
	}),
}

/**
 * Mirrors the key into OMP's `agent.db`, best effort.
 *
 * Failure is swallowed on purpose: OMP reads `models.yml` first, and a save that reported
 * failure because a database driver was absent would send the operator back to a form that had
 * actually worked.
 */
export async function writeOmpCredentials(input: {
	baseUrl: string
	apiKey: string
}): Promise<void> {
	let Database:
		| (new (
				path: string,
		  ) => {
				prepare: (sql: string) => { run: (...args: unknown[]) => unknown }
				close: () => void
		  })
		| null = null
	try {
		const mod = await import("better-sqlite3")
		Database = (mod.default ?? mod) as never
	} catch {
		return
	}

	const now = Math.floor(Date.now() / 1000)
	const db = new Database(OMP_DB_PATH())
	db.prepare("DELETE FROM auth_credentials WHERE provider = ?").run(OMP_PROVIDER_ID)
	db
		.prepare(
			"INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause, identity_key, created_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?, ?)",
		)
		.run(
			OMP_PROVIDER_ID,
			"api_key",
			JSON.stringify({ apiKey: input.apiKey, baseUrl: input.baseUrl }),
			now,
			now,
		)
	db.close()
}

/** OMP's reset drops our provider block from the YAML; the database row is left alone. */
export async function removeOmpSettings(): Promise<void> {
	const raw = await readText(OMP_YML_PATH())
	if (raw === null) return
	const { removeOmpProvider } = await import("9router-api/domain/omp-models-yml")
	await fs.writeFile(OMP_YML_PATH(), removeOmpProvider(raw), "utf-8")
}

/**
 * DeepSeek TUI's `~/.deepseek/config.toml`, which it owns wholesale.
 *
 * Unlike the other tools here, nothing is merged: the file is a complete config, so a save
 * replaces it and a reset writes the tool's own default (`provider = "deepseek"`) rather than
 * deleting it — an empty file is a tool that will not start.
 */
const DEEPSEEK_DIR = () => path.join(os.homedir(), ".deepseek")
const DEEPSEEK_CONFIG_PATH = () => path.join(DEEPSEEK_DIR(), "config.toml")

const DEEPSEEK_DEFAULT_TOML = 'provider = "deepseek"\n'

export const isDeepSeekTuiInstalled = async (): Promise<boolean> => {
	try {
		const isWindows = os.platform() === "win32"
		await execAsync(isWindows ? "where deepseek" : "which deepseek", { windowsHide: true })
		return true
	} catch {
		try {
			await fs.access(DEEPSEEK_CONFIG_PATH())
			return true
		} catch {
			return false
		}
	}
}

/** Renders the TOML DeepSeek TUI reads, in the shape it documents. */
function deepseekConfigToml(baseUrl: string, apiKey: string, model: string): string {
	const normalised = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`
	return [
		'provider = "openai"',
		"",
		"[providers.openai]",
		`base_url = "${normalised}"`,
		`api_key = "${apiKey}"`,
		`model = "${model}"`,
		"",
	].join("\n")
}

export const deepseekTuiSettingsConfig: ToolConfigPort = {
	path: DEEPSEEK_CONFIG_PATH(),
	format: "toml",
	read: async () => {
		const raw = await readText(DEEPSEEK_CONFIG_PATH())
		if (raw === null) return null
		return parseTomlDocument(raw)
	},
	readForWrite: async () => {
		const raw = await readText(DEEPSEEK_CONFIG_PATH())
		return raw === null ? {} : { raw }
	},
	write: async (text) => {
		await fs.mkdir(DEEPSEEK_DIR(), { recursive: true })
		await fs.writeFile(DEEPSEEK_CONFIG_PATH(), text, "utf-8")
	},
	baseUrlSuffix: "with-v1",
	required: ["baseUrl", "model"],
	resolveApiKey: (requested) => resolveCliApiKey(requested || null),
	installKeys: ["9router"],
	storedBaseUrl: () => null,
	// The reset value goes through the TOML serialiser like any other write, so it is stashed in
	// the same `toml` key `apply` uses rather than handed over as a plain object.
	resetTo: () => ({ toml: DEEPSEEK_DEFAULT_TOML }),
	/**
	 * The file is replaced, not merged, so `apply` stashes the rendered document and the
	 * serialiser only has to hand it back. `serialise` sees the config alone, never the form.
	 */
	serialise: (config) => String((config as { toml?: string }).toml ?? ""),
	apply: (_config, input) => ({
		toml: deepseekConfigToml(input.baseUrl, input.apiKey, input.model ?? ""),
	}),
}

/**
 * Parses the flat TOML DeepSeek TUI writes, keeping section names as dotted keys.
 *
 * The screen renders `settings` verbatim, so the shape matters: `providers.openai` is reported as
 * its own key rather than nested, exactly as the file reads.
 */
function parseTomlDocument(toml: string): Record<string, unknown> {
	const result: Record<string, unknown> = {}
	let current: Record<string, unknown> = result

	for (const line of toml.split(/\r?\n/)) {
		const trimmed = line.trim()
		if (!trimmed || trimmed.startsWith("#")) continue

		const section = trimmed.match(/^\[([^\]]+)\]$/)
		if (section?.[1]) {
			const name = section[1]
			const existing = result[name]
			current = existing && typeof existing === "object" ? (existing as Record<string, unknown>) : {}
			result[name] = current
			continue
		}

		const pair = trimmed.match(/^(\w+)\s*=\s*"([^"]*)"$/) ?? trimmed.match(/^(\w+)\s*=\s*(.+)$/)
		if (pair?.[1] && pair[2] !== undefined) current[pair[1]] = pair[2].trim()
	}

	return result
}
