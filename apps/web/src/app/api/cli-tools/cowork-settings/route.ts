import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
	bareToolNames,
	COWORK_PROVIDER,
	COWORK_SECURITY_RELAX,
	type CoworkConfig,
	type CoworkCustomPlugin,
	type CoworkManagedServer,
	coworkHasThisInstall,
	normaliseCoworkModels,
	normaliseCustomPlugins,
	readCoworkModels,
	skipApprovalsFor,
	withInjectedAuth,
} from "9router-api/domain/cowork-settings"
import { NextResponse } from "next/server"
import { SERVER_CONFIG } from "@/shared/constants/config"
import {
	buildManagedMcpServers,
	DEFAULT_PLUGINS,
	LOCAL_STDIO_PLUGINS,
} from "@/shared/constants/coworkPlugins"
import { getConsistentMachineId } from "@/shared/utils/machineId"

export const dynamic = "force-dynamic"

/** Claude Desktop config.json has a top-level MCP server registry. */
interface DesktopConfig {
	deploymentMode?: string
	mcpServers?: Record<string, Record<string, unknown>>
	[key: string]: unknown
}

/** Metadata identifying the active Cowork config-library entry. */
interface CoworkMeta {
	appliedId: string
	entries: Array<{ id: string; name: string }>
}

const APP_PORT = SERVER_CONFIG.port
const CLI_TOKEN_HEADER = "x-9r-cli-token"
const CLI_TOKEN_SALT = "9r-cli-auth"
const LOCAL_MCP_PREFIX = `http://localhost:${APP_PORT}/api/mcp/`

let cachedCliToken = null
const getCliToken = async () => {
	if (!cachedCliToken) cachedCliToken = await getConsistentMachineId(CLI_TOKEN_SALT)
	return cachedCliToken
}

// Inject CLI token header into entries pointing at our local /api/mcp/ bridge.
const injectAuthHeaders = async (entries: CoworkManagedServer[]): Promise<CoworkManagedServer[]> =>
	withInjectedAuth(entries, {
		localBridgePrefix: LOCAL_MCP_PREFIX,
		cliTokenHeader: CLI_TOKEN_HEADER,
		token: await getCliToken(),
	})

// Tools auto-allow per server via toolPolicy["*"] = "allow" semantics.
// 3p schema requires explicit tool names; we mark "*" via operonSkipMcpApprovals instead.

const getCandidateRoots = () => {
	if (os.platform() === "darwin") {
		const base = path.join(os.homedir(), "Library", "Application Support")
		return [path.join(base, "Claude-3p"), path.join(base, "Claude")]
	}
	if (os.platform() === "win32") {
		const localApp = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
		const roaming = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
		return [
			path.join(localApp, "Claude-3p"),
			path.join(roaming, "Claude-3p"),
			path.join(localApp, "Claude"),
			path.join(roaming, "Claude"),
		]
	}
	return [
		path.join(os.homedir(), ".config", "Claude-3p"),
		path.join(os.homedir(), ".config", "Claude"),
	]
}

const getAppInstallPaths = () => {
	if (os.platform() === "darwin") {
		return ["/Applications/Claude.app", path.join(os.homedir(), "Applications", "Claude.app")]
	}
	if (os.platform() === "win32") {
		const localApp = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
		const programFiles = process.env["ProgramFiles"] || "C:\\Program Files"
		return [
			path.join(localApp, "AnthropicClaude"),
			path.join(programFiles, "Claude"),
			path.join(programFiles, "AnthropicClaude"),
		]
	}
	return []
}

const resolveAppRootForRead = async () => {
	const candidates = getCandidateRoots()
	for (const dir of candidates) {
		try {
			await fs.access(path.join(dir, "configLibrary"))
			return dir
		} catch {
			/* try next */
		}
	}
	return candidates[0]
}

const getWriteRoot = () => getCandidateRoots()[0]
const getConfigDir = async () => path.join(await resolveAppRootForRead(), "configLibrary")
const getWriteConfigDir = () => path.join(getWriteRoot(), "configLibrary")
const getMetaPath = async () => path.join(await getConfigDir(), "_meta.json")
const getWriteMetaPath = () => path.join(getWriteConfigDir(), "_meta.json")

const get1pRoot = () => {
	if (os.platform() === "darwin")
		return path.join(os.homedir(), "Library", "Application Support", "Claude")
	if (os.platform() === "win32") {
		const roaming = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
		return path.join(roaming, "Claude")
	}
	return path.join(os.homedir(), ".config", "Claude")
}

const get1pConfigPath = () => path.join(get1pRoot(), "claude_desktop_config.json")

const read1pConfig = async (): Promise<DesktopConfig> => {
	try {
		const content = await fs.readFile(get1pConfigPath(), "utf-8")
		// Tolerate JSONC (trailing commas) and treat unparseable files as empty config
		// rather than throwing a 500 that the UI misreads as "tool not installed".
		const stripped = content.replace(/,(\s*[}\]])/g, "$1")
		return (JSON.parse(stripped) as DesktopConfig) || {}
	} catch (_error) {
		return {}
	}
}

const write1pConfig = async (cfg: DesktopConfig) => {
	await fs.mkdir(get1pRoot(), { recursive: true })
	await fs.writeFile(get1pConfigPath(), JSON.stringify(cfg, null, 2))
}

const bootstrapDeploymentMode = async () => {
	const cfg = await read1pConfig()
	if (cfg.deploymentMode === "3p") return false
	cfg.deploymentMode = "3p"
	await write1pConfig(cfg)
	return true
}

// Remove any legacy stdio entries previously written into 1p claude_desktop_config.json.
const cleanup1pLegacy = async () => {
	const cfg = await read1pConfig()
	if (!cfg.mcpServers || typeof cfg.mcpServers !== "object") return
	const managedNames = new Set(LOCAL_STDIO_PLUGINS.map((p) => p.name))
	for (const k of Object.keys(cfg.mcpServers)) {
		if (managedNames.has(k)) delete cfg.mcpServers[k]
	}
	if (Object.keys(cfg.mcpServers).length === 0) delete cfg.mcpServers
	await write1pConfig(cfg)
}

// Build SSE bridge entries pointing at this app's inline /api/mcp/{name} endpoint.
const buildLocalBridgeEntries = (localPluginNames: unknown): CoworkManagedServer[] => {
	const names: string[] = Array.isArray(localPluginNames)
		? localPluginNames.filter((name): name is string => typeof name === "string")
		: []
	const out: CoworkManagedServer[] = []
	for (const n of names) {
		const def = LOCAL_STDIO_PLUGINS.find((p) => p.name === n)
		if (!def) continue
		const entry: CoworkManagedServer = {
			name: def.name,
			url: `http://localhost:${APP_PORT}/api/mcp/${def.name}/sse`,
			transport: "sse",
		}
		if (Array.isArray(def.toolNames) && def.toolNames.length > 0) {
			const prefix = `${def.name}-`
			const policy: Record<string, string> = {}
			for (const t of def.toolNames) {
				policy[t] = "allow"
				policy[`${prefix}${t}`] = "allow"
			}
			entry.toolPolicy = policy
		}
		out.push(entry)
	}
	return out
}

// Build entries for user-defined custom MCP plugins (URL or stdio command).
const buildCustomEntries = (customPlugins: CoworkCustomPlugin[]): CoworkManagedServer[] => {
	const out: CoworkManagedServer[] = []
	for (const plugin of customPlugins) {
		out.push({
			name: plugin.name,
			url: plugin.url,
			transport: plugin.transport || "sse",
			custom: true,
		})
	}
	return out
}

const checkInstalled = async () => {
	for (const dir of [...getCandidateRoots(), ...getAppInstallPaths()]) {
		try {
			await fs.access(dir)
			return true
		} catch {
			/* try next */
		}
	}
	return false
}

const readJson = async <T extends object = CoworkConfig>(filePath: string): Promise<T | null> => {
	try {
		const content = await fs.readFile(filePath, "utf-8")
		// Tolerate JSONC (trailing commas) and treat unparseable files as "no config"
		// rather than throwing a 500 that the UI misreads as "tool not installed".
		const stripped = content.replace(/,(\s*[}\]])/g, "$1")
		return JSON.parse(stripped) as T
	} catch (_error) {
		return null
	}
}

const ensureMeta = async (): Promise<CoworkMeta> => {
	const writeMetaPath = getWriteMetaPath()
	let meta = await readJson<CoworkMeta>(writeMetaPath)
	if (!meta || !meta.appliedId) {
		const existingRead = await readJson<CoworkMeta>(await getMetaPath())
		if (existingRead?.appliedId) {
			meta = existingRead
		} else {
			const newId = crypto.randomUUID()
			meta = { appliedId: newId, entries: [{ id: newId, name: "Default" }] }
		}
		await fs.mkdir(getWriteConfigDir(), { recursive: true })
		await fs.writeFile(writeMetaPath, JSON.stringify(meta, null, 2))
	}
	return meta
}

// Auto-skip approvals for every managed server (no per-tool prompts).
async function writeSkipApprovals(managedServers: CoworkManagedServer[]) {
	const cfgPath = path.join(getWriteRoot(), "config.json")
	let cfg: CoworkConfig = {}
	try {
		cfg = (JSON.parse(await fs.readFile(cfgPath, "utf-8")) as CoworkConfig) || {}
	} catch (e) {
		if (e.code !== "ENOENT") return { error: e.code }
	}
	const skip = skipApprovalsFor(managedServers)
	cfg.operonSkipMcpApprovals = skip
	await fs.mkdir(getWriteRoot(), { recursive: true })
	await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2))
	return { written: Object.keys(skip).length }
}

export async function GET() {
	try {
		const installed = await checkInstalled()
		if (!installed) {
			return NextResponse.json({
				installed: false,
				config: null,
				message: "Claude Desktop (Cowork mode) not detected",
			})
		}
		const meta = await readJson(await getMetaPath())
		const appliedId = meta?.appliedId || null
		const configDir = await getConfigDir()
		const configPath = appliedId ? path.join(configDir, `${appliedId}.json`) : null
		const config = configPath ? await readJson(configPath) : null

		const baseUrl = config?.inferenceGatewayBaseUrl || null
		const models = readCoworkModels(config)
		const managedMcp = Array.isArray(config?.managedMcpServers) ? config.managedMcpServers : []
		const has9Router = coworkHasThisInstall(config)

		// Active local plugins = managedMcp entries whose URL points at our inline bridge.
		const stdioNames = new Set(LOCAL_STDIO_PLUGINS.map((p) => p.name))
		const activeLocalNames = managedMcp
			.filter(
				(m) => stdioNames.has(m.name) && typeof m.url === "string" && m.url.includes("/api/mcp/"),
			)
			.map((m) => m.name)

		// Custom plugins = bridge entries not in preset LOCAL_STDIO_PLUGINS (custom:true or unknown name).
		const activeCustomPlugins = managedMcp
			.filter(
				(m) =>
					m.custom ||
					(!stdioNames.has(m.name) && typeof m.url === "string" && m.url.includes("/api/mcp/")),
			)
			.map((m) => ({ name: m.name, url: m.url, transport: m.transport, custom: true }))

		return NextResponse.json({
			installed: true,
			config,
			has9Router,
			configPath,
			cowork: {
				appliedId,
				baseUrl,
				models,
				provider: config?.inferenceProvider || null,
				plugins: managedMcp
					.filter(
						(m) =>
							!m.custom &&
							!(stdioNames.has(m.name) && typeof m.url === "string" && m.url.includes("/api/mcp/")),
					)
					.map((m) => {
						// If a plugin matches a default, prefer its toolNames (curated/correct).
						const def = DEFAULT_PLUGINS.find((d) => d.name === m.name)
						const bare = bareToolNames(m.name, m.toolPolicy ? Object.keys(m.toolPolicy) : [])
						const toolNames = def && Array.isArray(def.toolNames) ? def.toolNames : bare
						return { name: m.name, url: m.url, transport: m.transport, oauth: !!m.oauth, toolNames }
					}),
				localPlugins: activeLocalNames,
				customPlugins: activeCustomPlugins,
			},
			defaultPlugins: DEFAULT_PLUGINS,
			localStdioPlugins: LOCAL_STDIO_PLUGINS,
		})
	} catch (error) {
		console.log("Error reading cowork settings:", error)
		return NextResponse.json({ error: "Failed to read cowork settings" }, { status: 500 })
	}
}

export async function POST(request) {
	try {
		const { baseUrl, apiKey, models, plugins, localPlugins, customPlugins } =
			(await request.json()) as {
				baseUrl?: string
				apiKey?: string
				models?: unknown
				plugins?: unknown
				localPlugins?: unknown
				customPlugins?: unknown
			}

		if (!baseUrl || !apiKey) {
			return NextResponse.json({ error: "baseUrl and apiKey are required" }, { status: 400 })
		}
		const modelsArray = normaliseCoworkModels(models)
		if (modelsArray.length === 0) {
			return NextResponse.json({ error: "At least one model is required" }, { status: 400 })
		}

		// Respect empty array (user toggled all off); fallback to defaults only when undefined.
		const pluginsArray = Array.isArray(plugins) ? plugins : DEFAULT_PLUGINS
		const localPluginNames = Array.isArray(localPlugins) ? localPlugins : []
		// Only URL-based custom plugins allowed (no stdio command spawning).
		const customPluginsArray = normaliseCustomPlugins(customPlugins)

		const bridgeEntries = await injectAuthHeaders(buildLocalBridgeEntries(localPluginNames))
		const customEntries = await injectAuthHeaders(buildCustomEntries(customPluginsArray))
		const managedMcpServers = [
			...buildManagedMcpServers(pluginsArray),
			...bridgeEntries,
			...customEntries,
		]

		const bootstrapped = await bootstrapDeploymentMode()
		const meta = await ensureMeta()
		const configPath = path.join(getWriteConfigDir(), `${meta.appliedId}.json`)

		const newConfig: CoworkConfig = {
			...COWORK_SECURITY_RELAX,
			inferenceProvider: COWORK_PROVIDER,
			inferenceGatewayBaseUrl: baseUrl,
			inferenceGatewayApiKey: apiKey,
			inferenceModels: modelsArray.map((name) => ({ name })),
		}
		if (managedMcpServers.length > 0) newConfig.managedMcpServers = managedMcpServers

		await fs.writeFile(configPath, JSON.stringify(newConfig, null, 2))

		let skipResult = null
		try {
			skipResult = await writeSkipApprovals(managedMcpServers)
		} catch (e) {
			skipResult = { error: e.message }
		}

		// Best-effort cleanup of legacy 1p mcpServers entries written by earlier versions.
		const localMcpResult = { applied: localPluginNames, via: "3p-sse-bridge" }
		try {
			await cleanup1pLegacy()
		} catch {
			/* ignore */
		}

		return NextResponse.json({
			success: true,
			bootstrapped,
			message: bootstrapped
				? "Cowork enabled (3p mode set). Quit & reopen Claude Desktop."
				: "Cowork settings applied. Quit & reopen Claude Desktop.",
			configPath,
			skipApprovals: skipResult,
			localMcp: localMcpResult,
		})
	} catch (error) {
		console.log("Error applying cowork settings:", error)
		return NextResponse.json({ error: "Failed to apply cowork settings" }, { status: 500 })
	}
}

export async function DELETE() {
	try {
		const meta = await readJson(await getMetaPath())
		if (!meta?.appliedId) {
			return NextResponse.json({ success: true, message: "No active config to reset" })
		}
		const configPath = path.join(await getConfigDir(), `${meta.appliedId}.json`)
		try {
			await fs.writeFile(configPath, JSON.stringify({}, null, 2))
		} catch (error) {
			if (error.code !== "ENOENT") throw error
		}
		try {
			await writeSkipApprovals([])
		} catch {
			/* ignore */
		}
		try {
			await cleanup1pLegacy()
		} catch {
			/* ignore */
		}
		return NextResponse.json({ success: true, message: "Cowork config reset" })
	} catch (error) {
		console.log("Error resetting cowork settings:", error)
		return NextResponse.json({ error: "Failed to reset cowork settings" }, { status: 500 })
	}
}
