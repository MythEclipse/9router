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

import { execAsync, readText } from "./shared.ts"

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

/**
 * jcode's `~/.jcode/config.toml` plus a provider env file under `XDG_CONFIG_HOME`.
 *
 * The key never goes in the TOML: jcode reads it from `provider-9router.env` and the config only
 * names that file, so the two writes have to agree or jcode looks for a variable nothing sets.
 */
const JCODE_CONFIG_DIR = () => path.join(os.homedir(), ".jcode")
const JCODE_CONFIG_PATH = () => path.join(JCODE_CONFIG_DIR(), "config.toml")
const JCODE_ENV_PATH = () =>
	path.join(
		process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
		"jcode",
		"provider-9router.env",
	)
/** Where jcode's own config lives, reported by the status screen. */
export const jcodeConfigPath = JCODE_CONFIG_PATH

export const isJcodeInstalled = async (): Promise<boolean> => {
	try {
		const isWindows = os.platform() === "win32"
		await execAsync(isWindows ? "where jcode" : "which jcode", { windowsHide: true })
		return true
	} catch {
		try {
			await fs.access(JCODE_CONFIG_DIR())
			return true
		} catch {
			return false
		}
	}
}

/** One `KEY="value"` line per variable, skipping blanks and comments. */
function parseEnvFile(content: string): Record<string, string> {
	const env: Record<string, string> = {}
	for (const line of content.split("\n")) {
		const trimmed = line.trim()
		if (!trimmed || trimmed.startsWith("#")) continue
		const at = trimmed.indexOf("=")
		if (at <= 0) continue
		const key = trimmed.slice(0, at).trim()
		let value = trimmed.slice(at + 1).trim()
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1)
		}
		env[key] = value
	}
	return env
}

/** Rewrites the provider env file, keeping whatever else it holds. */
export async function writeJcodeEnv(apiKey: string): Promise<void> {
	let env: Record<string, string> = {}
	try {
		env = parseEnvFile(await fs.readFile(JCODE_ENV_PATH(), "utf-8"))
	} catch {
		// first write: start from the header alone
	}
	env[JCODE_KEY_ENV] = apiKey
	await fs.mkdir(path.dirname(JCODE_ENV_PATH()), { recursive: true })
	const body = Object.entries(env)
		.map(([key, value]) => `${key}="${value}"`)
		.join("\n")
	await fs.writeFile(JCODE_ENV_PATH(), `# jcode provider environment variables\n${body}\n`, "utf-8")
}

/** Drops only our variable, so a key set for another provider survives a reset. */
export async function removeJcodeEnv(): Promise<void> {
	let env: Record<string, string>
	try {
		env = parseEnvFile(await fs.readFile(JCODE_ENV_PATH(), "utf-8"))
	} catch {
		return
	}
	delete env[JCODE_KEY_ENV]
	const body = Object.entries(env)
		.map(([key, value]) => `${key}="${value}"`)
		.join("\n")
	await fs.writeFile(JCODE_ENV_PATH(), `# jcode provider environment variables\n${body}\n`, "utf-8")
}

export const jcodeSettingsConfig: ToolConfigPort = {
	path: JCODE_CONFIG_PATH(),
	format: "toml",
	read: async () => {
		const raw = await readText(JCODE_CONFIG_PATH())
		if (raw === null) return null
		return { ...parseTomlDocument(raw), rawToml: raw, has9Router: jcodeHasThisInstall(raw) }
	},
	readForWrite: async () => {
		// The raw document, because the writer splices text instead of re-serialising: a
		// round-trip would rewrite comments and ordering on every save.
		const raw = await readText(JCODE_CONFIG_PATH())
		return { rawToml: raw ?? "" }
	},
	write: async (text) => {
		await fs.mkdir(JCODE_CONFIG_DIR(), { recursive: true })
		await fs.writeFile(JCODE_CONFIG_PATH(), text, "utf-8")
	},
	baseUrlSuffix: "with-v1",
	// Unlike the other tools, jcode cannot read the key from the TOML: it resolves
	// `api_key_env` at runtime, so a save without a key writes an entry that cannot authenticate.
	required: ["baseUrl", "apiKey"],
	resolveApiKey: async (requested) => requested ?? "",
	installKeys: ["9router"],
	storedBaseUrl: () => null,
	serialise: (config) => String((config as { toml?: string }).toml ?? ""),
	apply: (config, input) => ({
		toml: withJcodeProvider(
			String((config as { rawToml?: string }).rawToml ?? ""),
			input.baseUrl,
			input.model ?? "cc/claude-opus-4-7",
		),
	}),
}
