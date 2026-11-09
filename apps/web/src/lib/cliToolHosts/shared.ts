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

export const execAsync = promisify(exec)

/**
 * Kilo Code CLI's own layout.
 *
 * The CLI keeps every provider under one `auth.json` keyed by provider name, and the VS Code
 * extension keeps its settings in the editor's own file. Both spellings of this install's
 * provider key are recognised: `openai-compatible` is what the CLI expects, `9router` is what
 * an earlier version of this screen wrote.
 */

export const KILO_DATA_DIR = () => path.join(os.homedir(), ".local", "share", "kilo")
export const KILO_AUTH_PATH = () => path.join(KILO_DATA_DIR(), "auth.json")
export const VSCODE_SETTINGS_PATH = () =>
	path.join(os.homedir(), ".config", "Code", "User", "settings.json")

/**
 * Reads a JSON file, tolerating JSONC and a missing file.
 *
 * A config the tool itself can parse but `JSON.parse` cannot (trailing commas are common in
 * editor settings) must not read as 500: the screen would misreport it as "tool not installed",
 * and the operator would reinstall a tool that is already there.
 */
export async function readJson(filePath: string): Promise<Record<string, unknown> | null> {
	try {
		const content = await fs.readFile(filePath, "utf-8")
		return JSON.parse(content.replace(/,(\s*[}\]])/g, "$1"))
	} catch {
		return null
	}
}

/** The file's text, or null when there is no file — the raw form `readForWrite` needs. */
export async function readText(filePath: string): Promise<string | null> {
	try {
		return await fs.readFile(filePath, "utf-8")
	} catch {
		return null
	}
}
