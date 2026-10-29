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
import { parseTOML, stringifyTOML } from "confbox"
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
 * CodeWhale's layout: `[openai]` in a TOML file, with every other table re-written untouched.
 *
 * This is the first TOML tool here, so the host supplies both halves of the format — the
 * parser used by `readForWrite` and the serialiser used on write — because a file written as
 * TOML but parsed as JSON reads back as garbage the moment the tool next loads it.
 */

const CODEWHALE_CONFIG_DIR = () => path.join(os.homedir(), ".codewhale")
const CODEWHALE_CONFIG_PATH = () => path.join(CODEWHALE_CONFIG_DIR(), "config.toml")

type CodewhaleConfig = { openai?: Record<string, unknown>; [key: string]: unknown }

async function isCodewhaleInstalled(): Promise<boolean> {
	try {
		const isWindows = os.platform() === "win32"
		await execAsync(isWindows ? "where codewhale" : "which codewhale", { windowsHide: true })
		return true
	} catch {
		try {
			await fs.access(CODEWHALE_CONFIG_PATH())
			return true
		} catch {
			return false
		}
	}
}

export const codewhaleSettingsConfig: ToolConfigPort = {
	path: CODEWHALE_CONFIG_PATH(),
	read: async () => {
		const raw = await readText(CODEWHALE_CONFIG_PATH())
		if (raw === null) return null
		try {
			return (parseTOML(raw) ?? {}) as Record<string, unknown>
		} catch {
			return null
		}
	},
	readForWrite: async () =>
		readConfigForWrite(
			fs,
			CODEWHALE_CONFIG_PATH(),
			(raw) => (parseTOML(raw) ?? {}) as Record<string, unknown>,
		),
	write: async (text) => {
		await fs.mkdir(CODEWHALE_CONFIG_DIR(), { recursive: true })
		await fs.writeFile(CODEWHALE_CONFIG_PATH(), text, "utf-8")
	},
	format: "toml",
	// The file is ours from the first write, and the header says so; a tool that loses this
	// comment still keeps working, so the marker is a courtesy rather than a mechanism.
	serialise: (config) => `# CodeWhale config - managed by 9Router\n\n${stringifyTOML(config)}`,
	baseUrlSuffix: "with-v1",
	installKeys: ["openai"],
	storedBaseUrl: (config) => {
		const openai = (config as CodewhaleConfig)?.openai
		return typeof openai?.base_url === "string" ? openai.base_url : null
	},
	apply: (config, input) => ({
		...(config as CodewhaleConfig),
		openai: {
			base_url: input.baseUrl,
			api_key: input.apiKey,
			model: input.model || "provider/model-id",
		},
	}),
}

/** CodeWhale's reset drops the table, and the file only when no other table remains. */
export async function removeCodewhaleSettings(): Promise<void> {
	const raw = await readText(CODEWHALE_CONFIG_PATH())
	if (raw === null) return
	let config: CodewhaleConfig
	try {
		config = (parseTOML(raw) ?? {}) as CodewhaleConfig
	} catch {
		return
	}
	delete config.openai
	if (Object.keys(config).length === 0) {
		await fs.rm(CODEWHALE_CONFIG_PATH(), { force: true })
		return
	}
	await fs.writeFile(CODEWHALE_CONFIG_PATH(), stringifyTOML(config), "utf-8")
}

export { isCodewhaleInstalled }

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
