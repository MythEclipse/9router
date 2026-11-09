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
import { requestedModelsOf } from "./opencodeDroid.ts"
import { execAsync, readJson, readText } from "./shared.ts"

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
