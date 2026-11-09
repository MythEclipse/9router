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
import { detectInstall, openAiTomlConfig, removeOpenAiTomlTable } from "./openAiToml.ts"
import { execAsync, readJson } from "./shared.ts"

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
