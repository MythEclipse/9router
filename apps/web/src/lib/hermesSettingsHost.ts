import { exec } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import type {
	HermesFilesPort,
	HermesHomeView,
	HermesProfileSummary,
} from "9router-api/application/hermes/manage-hermes-settings"
import {
	commandFor,
	displayNameFrom,
	hermesRoot,
	IDENTITY_FILES,
	profilesRoot,
	resolveHermesHome,
} from "9router-api/domain/hermes-profiles"
import {
	has9RouterConfig,
	parseAuxRoles,
	parseDelegationBlock,
	parseModelBlock,
	upsertEnvVar,
} from "9router-api/domain/hermes-yaml"

/**
 * Hermes's home directories, as the application layer wants to see them.
 *
 * Every rule about *which* directory a profile name means is already in
 * `domain/hermes-profiles`; what is left here is the file access. The four tolerances below are
 * facts about the filesystem rather than about Hermes, which is why they live at this edge:
 *
 * - a missing `config.yaml` or `.env` reads as "" — that is a fresh profile, not a failure;
 * - a missing named home is `false`, so the caller can answer 404;
 * - only the default home is ever created, because a named one without identity files is not a
 *   profile and `hermes profile create` is what makes one;
 * - a directory under `profiles/` counts only when it carries an identity file, the same rule
 *   Hermes uses to decide what to run.
 */

const execAsync = promisify(exec)

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT"

const readText = async (file: string): Promise<string> => {
	try {
		return await fs.readFile(file, "utf-8")
	} catch (error) {
		if (isMissing(error)) return ""
		throw error
	}
}

const dirExists = async (dir: string): Promise<boolean> => {
	try {
		return (await fs.stat(dir)).isDirectory()
	} catch {
		return false
	}
}

/** Whether a directory carries one of the files that makes it a profile. */
const isProfileHome = async (dir: string): Promise<boolean> => {
	for (const file of IDENTITY_FILES) {
		try {
			await fs.stat(path.join(dir, file))
			return true
		} catch {
			// keep looking
		}
	}
	return false
}

/** One profile row, read from its own files. */
const summarise = async (
	name: string,
	dir: string,
	isDefault: boolean,
): Promise<HermesProfileSummary> => {
	const yaml = await readText(path.join(dir, "config.yaml"))
	const model = parseModelBlock(yaml)
	const delegation = parseDelegationBlock(yaml)
	const auxiliary = parseAuxRoles(yaml)

	return {
		name,
		dir,
		isDefault,
		displayName: displayNameFrom(await readText(path.join(dir, "profile.yaml"))),
		command: commandFor(name, isDefault),
		alias: isDefault ? null : name,
		model: model?.default || null,
		baseUrl: model?.base_url || null,
		has9Router:
			has9RouterConfig(model) ||
			has9RouterConfig(delegation) ||
			Object.values(auxiliary).some(has9RouterConfig),
	}
}

/** The install root used when the caller passes no override. */
const root = (): string => hermesRoot(undefined, os.homedir())

/**
 * Every profile on this machine: the default home, then each recognised directory under
 * `profiles/`.
 *
 * A missing `profiles/` yields just the default rather than an error — Hermes itself treats that
 * as a normal install, and a machine with no profiles is the state before the first one is made.
 */
export const listHermesProfiles = async (): Promise<HermesProfileSummary[]> => {
	const base = root()
	const entries = [await summarise("default", base, true)]

	let dirents: import("node:fs").Dirent[]
	try {
		dirents = await fs.readdir(profilesRoot(base), { withFileTypes: true })
	} catch (error) {
		if (isMissing(error)) return entries
		throw error
	}

	const names = dirents
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort((a, b) => a.localeCompare(b))

	for (const name of names) {
		const dir = path.join(profilesRoot(base), name)
		if (!(await isProfileHome(dir))) continue
		entries.push(await summarise(name, dir, false))
	}
	return entries
}

/** Hermes is installed when its CLI answers, or when its default config exists. */
const isHermesInstalled = async (): Promise<boolean> => {
	try {
		const isWindows = os.platform() === "win32"
		await execAsync(isWindows ? "where hermes" : "which hermes", { windowsHide: true })
		return true
	} catch {
		try {
			await fs.access(path.join(root(), "config.yaml"))
			return true
		} catch {
			return false
		}
	}
}

const asView = (home: ReturnType<typeof resolveHermesHome>): HermesHomeView => home

export const hermesFilesPort: HermesFilesPort = {
	resolve: (profile) => {
		try {
			return { home: asView(resolveHermesHome(profile, undefined as never, os.homedir())) }
		} catch (error) {
			return { error: error instanceof Error ? error.message : "Invalid profile" }
		}
	},

	dirExists,

	readConfig: (home) => readText(home.configPath),

	readEnv: (home) => readText(home.envPath),

	// Only the default home is created here: a named profile without identity files is not a
	// profile, and fabricating one would offer the operator something Hermes cannot run.
	writeConfig: async (home, yaml) => {
		if (home.isDefault) await fs.mkdir(home.dir, { recursive: true })
		await fs.writeFile(home.configPath, yaml)
	},

	// `.env` also carries bot tokens and channel credentials, so only our one line is touched.
	writeEnvKey: async (home, apiKey) => {
		if (!apiKey) return
		if (home.isDefault) await fs.mkdir(home.dir, { recursive: true })
		const env = upsertEnvVar(await readText(home.envPath), "OPENAI_API_KEY", apiKey)
		await fs.writeFile(home.envPath, env)
	},

	configMissing: async (home) => {
		try {
			await fs.access(home.configPath)
			return false
		} catch (error) {
			if (isMissing(error)) return true
			throw error
		}
	},

	isInstalled: isHermesInstalled,

	listProfiles: listHermesProfiles,
}
