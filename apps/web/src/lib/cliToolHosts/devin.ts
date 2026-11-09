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

import { execAsync } from "./shared.ts"

/**
 * Devin, which is detection and nothing else.
 *
 * It keeps its own credentials and has no settings file this install writes, so the "port" is
 * two probes rather than a config port. `devinBinCandidates` is shared with the executor on
 * purpose: if detection walked a different list from the one the app launches, the screen could
 * say "installed" about a binary nothing can run.
 */
export const devinInstallPort: DevinInstallPort = {
	onPath: async () => {
		const isWindows = os.platform() === "win32"
		try {
			await execAsync(isWindows ? "where devin" : "which devin", { windowsHide: true })
			return true
		} catch {
			return false
		}
	},
	candidates: () =>
		devinBinCandidates({
			platform: os.platform(),
			home: os.homedir(),
			localAppData: process.env.LOCALAPPDATA,
		}),
	exists: async (candidate) => {
		try {
			await fs.access(candidate)
			return true
		} catch {
			return false
		}
	},
}

export const devinVersionPort: DevinVersionPort = {
	version: async () => {
		try {
			const { stdout } = await execAsync("devin --version", { windowsHide: true })
			return stdout.trim().split("\n")[0] || null
		} catch {
			return null
		}
	},
}
