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
import { execAsync, readText } from "./shared.ts"

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
