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

export function openAiTomlConfig(options: {
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

/** Is the tool's binary on PATH, or does its config already exist? */
export async function detectInstall(binary: string, configPath: string): Promise<boolean> {
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
export async function removeOpenAiTomlTable(configPath: string): Promise<void> {
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
