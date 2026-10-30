/**
 * Where Claude Desktop keeps its files, and how this process reaches them.
 *
 * Every path in here is a platform question, which is why none of it lives in `apps/api`: the
 * candidates differ between macOS, Windows and Linux, and the read root is *discovered* while the
 * write root is fixed. Writes must land where the app reads, and on a machine where the newer
 * `Claude-3p` directory does not exist yet, the app will create it — so an early write into a
 * discovered older `Claude` directory would be invisible to it.
 */
import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { CoworkMeta } from "9router-api/application/cowork-settings/manage-cowork-settings"
import { SERVER_CONFIG } from "@/shared/constants/config"
import { getConsistentMachineId } from "@/shared/utils/machineId"

/** Claude Desktop's own config file, which holds a top-level `mcpServers` registry. */
type DesktopConfig = Record<string, unknown>

const home = () => os.homedir()
const platform = () => os.platform()

/** Where Cowork's config library may live, best candidate first. */
export function candidateRoots(): string[] {
	const base = platform()
	if (base === "darwin") {
		const support = path.join(home(), "Library", "Application Support")
		return [path.join(support, "Claude-3p"), path.join(support, "Claude")]
	}
	if (base === "win32") {
		const localApp = process.env.LOCALAPPDATA || path.join(home(), "AppData", "Local")
		const roaming = process.env.APPDATA || path.join(home(), "AppData", "Roaming")
		return [
			path.join(localApp, "Claude-3p"),
			path.join(roaming, "Claude-3p"),
			path.join(localApp, "Claude"),
			path.join(roaming, "Claude"),
		]
	}
	return [path.join(home(), ".config", "Claude-3p"), path.join(home(), ".config", "Claude")]
}

/** Where the app itself is installed, for machines with no config directory yet. */
export function installPaths(): string[] {
	const base = platform()
	if (base === "darwin") {
		return ["/Applications/Claude.app", path.join(home(), "Applications", "Claude.app")]
	}
	if (base === "win32") {
		const localApp = process.env.LOCALAPPDATA || path.join(home(), "AppData", "Local")
		const programFiles = process.env.ProgramFiles || "C:\\Program Files"
		return [
			path.join(localApp, "AnthropicClaude"),
			path.join(programFiles, "Claude"),
			path.join(programFiles, "AnthropicClaude"),
		]
	}
	return []
}

/** The first-party config directory — a different one from the Cowork candidates above. */
export const firstPartyRoot = (): string => {
	if (platform() === "darwin") return path.join(home(), "Library", "Application Support", "Claude")
	if (platform() === "win32") {
		const roaming = process.env.APPDATA || path.join(home(), "AppData", "Roaming")
		return path.join(roaming, "Claude")
	}
	return path.join(home(), ".config", "Claude")
}

const exists = async (target: string): Promise<boolean> => {
	try {
		await fs.access(target)
		return true
	} catch {
		return false
	}
}

/** The root the app actually reads, falling back to the first candidate on a fresh install. */
export const resolveReadRoot = async (): Promise<string> => {
	const candidates = candidateRoots()
	for (const dir of candidates) {
		if (await exists(path.join(dir, "configLibrary"))) return dir
	}
	return candidates[0]
}

export const resolveIsInstalled = async (): Promise<boolean> => {
	for (const dir of [...candidateRoots(), ...installPaths()]) {
		if (await exists(dir)) return true
	}
	return false
}

/** JSONC is tolerated: a trailing comma must not read as "tool not installed". */
const parseJsonc = <T>(content: string): T => JSON.parse(content.replace(/,(\s*[}\]])/g, "$1")) as T

export async function readJsonFile<T extends object>(filePath: string): Promise<T | null> {
	try {
		return parseJsonc<T>(await fs.readFile(filePath, "utf-8"))
	} catch {
		return null
	}
}

async function readTextFile(filePath: string): Promise<string | null> {
	try {
		return await fs.readFile(filePath, "utf-8")
	} catch {
		return null
	}
}

async function writeTextFile(filePath: string, content: string): Promise<void> {
	await fs.writeFile(filePath, content)
}

/**
 * The active config-library entry id.
 *
 * Reused from the read root when one exists, so a machine that already points somewhere keeps
 * pointing there; otherwise a fresh id is minted and indexed as `Default`.
 */
async function ensureMeta(writeMetaPath: string, readMetaPath: string): Promise<CoworkMeta> {
	const own = await readJsonFile<CoworkMeta>(writeMetaPath)
	if (own?.appliedId) return own

	const inherited = await readJsonFile<CoworkMeta>(readMetaPath)
	if (inherited?.appliedId) {
		await fs.mkdir(path.dirname(writeMetaPath), { recursive: true })
		await writeTextFile(writeMetaPath, JSON.stringify(inherited, null, 2))
		return inherited
	}

	const id = crypto.randomUUID()
	const meta: CoworkMeta = { appliedId: id, entries: [{ id, name: "Default" }] }
	await fs.mkdir(path.dirname(writeMetaPath), { recursive: true })
	await writeTextFile(writeMetaPath, JSON.stringify(meta, null, 2))
	return meta
}

const desktopConfigPath = () => path.join(firstPartyRoot(), "claude_desktop_config.json")

/** A cache, because the machine id is derived once per process and never changes. */
let cachedCliToken: string | null = null

/** The token this app's own `/api/mcp/` bridge expects, derived from the machine id. */
export async function cliToken(): Promise<string | null> {
	if (!cachedCliToken) {
		cachedCliToken = await getConsistentMachineId("9r-cli-auth")
	}
	return cachedCliToken
}

const writeConfigDir = () => path.join(candidateRoots()[0], "configLibrary")

export const coworkFilesPort = {
	readRoot: resolveReadRoot,
	writeRoot: () => candidateRoots()[0],
	isInstalled: resolveIsInstalled,
	readJson: readJsonFile,
	readText: readTextFile,
	writeText: writeTextFile,
	ensureDir: async (dir: string) => {
		await fs.mkdir(dir, { recursive: true })
	},
	ensureMeta,
	configDir: async () => path.join(await resolveReadRoot(), "configLibrary"),
	writeConfigDir,
	metaPath: async () => path.join(await resolveReadRoot(), "configLibrary", "_meta.json"),
	writeMetaPath: () => path.join(writeConfigDir(), "_meta.json"),
	desktopConfig: async (): Promise<DesktopConfig> => {
		const cfg = await readJsonFile<DesktopConfig>(desktopConfigPath())
		return cfg ?? {}
	},
	writeDesktopConfig: async (cfg: DesktopConfig) => {
		await fs.mkdir(firstPartyRoot(), { recursive: true })
		await writeTextFile(desktopConfigPath(), JSON.stringify(cfg, null, 2))
	},
}

/** The base URL of this app's inline MCP bridge, which the entries are pointed at. */
export const localBridgePrefix = `http://localhost:${SERVER_CONFIG.port}/api/mcp/`
