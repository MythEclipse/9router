/**
 * Claude Desktop (Cowork mode) settings.
 *
 * The route this replaces was 449 lines of filesystem work with the decisions buried inside it.
 * The decisions are what live here; the paths come from the host, because "where is the Claude
 * app on this machine" is a question only the machine can answer.
 *
 * Three verbs, and each has one rule worth stating:
 *
 * - **POST** writes a fresh config for the active entry id and refreshes the *3p* deployment mode,
 *   because Cowork only reads that mode. It reports, per step, what it could not do — a failure to
 *   write skip-approvals must not lose the settings that were already written.
 * - **DELETE** empties the active config rather than deleting it. Claude Desktop keeps the entry
 *   id in its library index; removing the file makes it look corrupt to the app, while `{}` reads
 *   as "no settings", which is what reset means.
 * - **GET** never fails for a missing app. It answers `installed: false`, because the screen uses
 *   that to decide whether to offer the card at all.
 */
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
} from "../../domain/cowork-settings.ts"

/** One plugin preset, as the dashboard ships it. */
export interface CoworkPluginPreset {
	readonly name: string
	readonly url?: string
	readonly transport?: string
	readonly toolNames?: readonly string[]
}

/** A stdio plugin this app bridges itself, served from its own `/api/mcp/{name}/sse`. */
export interface CoworkLocalPlugin {
	readonly name: string
	readonly toolNames?: readonly string[]
}

/** A config-library entry, as Claude Desktop indexes it. */
export interface CoworkMeta {
	readonly appliedId: string
	readonly entries: ReadonlyArray<{ readonly id: string; readonly name: string }>
}

/** The config-library files this flow is allowed to read and write. */
export interface CoworkFilesPort {
	/** The directory the app actually reads from, or the first candidate when none exists yet. */
	readonly readRoot: () => Promise<string>
	/** The directory a write must land in: the first candidate, never a discovered one. */
	readonly writeRoot: () => string
	readonly isInstalled: () => Promise<boolean>
	readonly readJson: <T extends object>(filePath: string) => Promise<T | null>
	readonly readText: (filePath: string) => Promise<string | null>
	readonly writeText: (filePath: string, content: string) => Promise<void>
	readonly ensureDir: (dir: string) => Promise<void>
	/** The id Claude Desktop will read; created on first use and reused after that. */
	readonly ensureMeta: (writeMetaPath: string, readMetaPath: string) => Promise<CoworkMeta>
	readonly configDir: () => Promise<string>
	readonly writeConfigDir: () => string
	readonly metaPath: () => Promise<string>
	readonly writeMetaPath: () => string
	/** The *first-party* Desktop config — a different file from the Cowork one. */
	readonly desktopConfig: () => Promise<Record<string, unknown>>
	readonly writeDesktopConfig: (cfg: Record<string, unknown>) => Promise<void>
}

export interface CoworkDependencies {
	readonly port: CoworkFilesPort
	readonly pluginPresets: readonly CoworkPluginPreset[]
	readonly localPlugins: readonly CoworkLocalPlugin[]
	/** Builds preset entries; a web constant today, injected so the assembly is testable. */
	readonly buildPresetEntries: (plugins: unknown) => CoworkManagedServer[]
	/** The base URL of this app's inline MCP bridge, e.g. `http://localhost:20128/api/mcp/`. */
	readonly localBridgePrefix: string
	readonly cliTokenHeader: string
	/** `null` means "could not read a machine id" — the entries then go out without auth. */
	readonly cliToken: () => Promise<string | null>
}

export interface CoworkAnswer {
	readonly status: number
	readonly body: Record<string, unknown>
}

const fail = (status: number, message: string): CoworkAnswer => ({
	status,
	body: { error: message },
})

const messageOf = (error: unknown, fallback: string): string =>
	error instanceof Error ? error.message : fallback

/** Entries pointing at this app's own bridge carry the CLI token, or the bridge rejects them. */
const withAuth = async (
	entries: CoworkManagedServer[],
	deps: CoworkDependencies,
): Promise<CoworkManagedServer[]> =>
	withInjectedAuth(entries, {
		localBridgePrefix: deps.localBridgePrefix,
		cliTokenHeader: deps.cliTokenHeader,
		token: await deps.cliToken(),
	})

/**
 * Bridge entries for the local plugins the user enabled.
 *
 * A name with no preset is skipped rather than guessed at: the URL is built from the name, so an
 * unknown one would point at an endpoint that does not exist.
 */
const bridgeEntries = (names: unknown, deps: CoworkDependencies): CoworkManagedServer[] => {
	const wanted = Array.isArray(names) ? names.filter((n): n is string => typeof n === "string") : []
	const out: CoworkManagedServer[] = []
	for (const name of wanted) {
		const preset = deps.localPlugins.find((plugin) => plugin.name === name)
		if (!preset) continue
		const entry: CoworkManagedServer = {
			name: preset.name,
			url: `${deps.localBridgePrefix}${preset.name}/sse`,
			transport: "sse",
		}
		const toolNames = preset.toolNames ?? []
		if (toolNames.length > 0) {
			// The app accepts both the bare tool name and the server-prefixed one; mark both so a
			// tool is never blocked by which form the client happens to send.
			const policy: Record<string, string> = {}
			for (const tool of toolNames) {
				policy[tool] = "allow"
				policy[`${preset.name}-${tool}`] = "allow"
			}
			entry.toolPolicy = policy
		}
		out.push(entry)
	}
	return out
}

/** Custom plugins are URL-only: a stdio command from a request body is code execution. */
const customEntries = (plugins: CoworkCustomPlugin[]): CoworkManagedServer[] =>
	plugins.map((plugin) => ({
		name: plugin.name,
		url: plugin.url,
		transport: plugin.transport || "sse",
		custom: true,
	}))

/** Cowork only reads configs written in 3p mode, so this runs before every write. */
const bootstrapDeploymentMode = async (port: CoworkFilesPort): Promise<boolean> => {
	const cfg = await port.desktopConfig()
	if (cfg.deploymentMode === "3p") return false
	await port.writeDesktopConfig({ ...cfg, deploymentMode: "3p" })
	return true
}

/**
 * Remove stdio entries an earlier version wrote into the first-party config.
 *
 * That file is shared with plain Claude Desktop, so only the names this app owns are touched and
 * the `mcpServers` key is dropped only once it is empty.
 */
const cleanupDesktopLegacy = async (
	port: CoworkFilesPort,
	ownedNames: readonly string[],
): Promise<void> => {
	const cfg = await port.desktopConfig()
	const servers = cfg.mcpServers
	if (!servers || typeof servers !== "object") return
	const managed = new Set(ownedNames)
	const remaining = { ...(servers as Record<string, unknown>) }
	for (const key of Object.keys(remaining)) {
		if (managed.has(key)) delete remaining[key]
	}
	const next = { ...cfg }
	if (Object.keys(remaining).length === 0) delete next.mcpServers
	else next.mcpServers = remaining
	await port.writeDesktopConfig(next)
}

/**
 * Turn off per-tool approval prompts for every server this app manages.
 *
 * A config file that exists but does not parse is *not* overwritten: it is the user's file and
 * may hold their own servers. The caller gets the parse failure back instead.
 */
const writeSkipApprovals = async (
	port: CoworkFilesPort,
	servers: CoworkManagedServer[],
): Promise<{ written: number } | { error: string }> => {
	const root = port.writeRoot()
	const configPath = `${root}/config.json`
	const existing = await port.readText(configPath)
	let cfg: CoworkConfig = {}
	if (existing !== null) {
		try {
			cfg = (JSON.parse(existing) as CoworkConfig) || {}
		} catch (error) {
			return { error: messageOf(error, "config.json is not valid JSON") }
		}
	}
	const skip = skipApprovalsFor(servers)
	await port.ensureDir(root)
	await port.writeText(configPath, JSON.stringify({ ...cfg, operonSkipMcpApprovals: skip }, null, 2))
	return { written: Object.keys(skip).length }
}

/**
 * What the screen needs to draw the card.
 *
 * Three lists are derived from one `managedMcpServers` array and they must not overlap: preset
 * plugins, local bridge plugins, and custom plugins. The overlap rules are here rather than in the
 * component because a server that appears twice is a server the user thinks they configured twice.
 */
async function readAnswer(deps: CoworkDependencies): Promise<CoworkAnswer> {
	const { port } = deps
	if (!(await port.isInstalled())) {
		return {
			status: 200,
			body: {
				installed: false,
				config: null,
				message: "Claude Desktop (Cowork mode) not detected",
			},
		}
	}

	const meta = await port.readJson<CoworkMeta>(await port.metaPath())
	const appliedId = meta?.appliedId ?? null
	const configDir = await port.configDir()
	const configPath = appliedId ? `${configDir}/${appliedId}.json` : null
	const config = configPath ? await port.readJson<CoworkConfig>(configPath) : null

	const managed = Array.isArray(config?.managedMcpServers) ? config.managedMcpServers : []
	const localNames = new Set(deps.localPlugins.map((plugin) => plugin.name))
	const isLocalBridge = (server: CoworkManagedServer): boolean =>
		localNames.has(server.name) && typeof server.url === "string" && server.url.includes("/api/mcp/")

	const presetNames = new Set(deps.pluginPresets.map((preset) => preset.name))

	return {
		status: 200,
		body: {
			installed: true,
			config,
			has9Router: coworkHasThisInstall(config),
			configPath,
			cowork: {
				appliedId,
				baseUrl: config?.inferenceGatewayBaseUrl ?? null,
				models: readCoworkModels(config),
				provider: config?.inferenceProvider ?? null,
				plugins: managed
					.filter((server) => !server.custom && !isLocalBridge(server))
					.map((server) => {
						// A shipped preset knows its own tool names, and that list is curated; the policy
						// keys in the file are only a fallback for a server we do not know.
						const preset = deps.pluginPresets.find((entry) => entry.name === server.name)
						const fromPolicy = bareToolNames(
							server.name,
							server.toolPolicy ? Object.keys(server.toolPolicy) : [],
						)
						return {
							name: server.name,
							url: server.url,
							transport: server.transport,
							oauth: Boolean(server.oauth),
							toolNames: preset && Array.isArray(preset.toolNames) ? preset.toolNames : fromPolicy,
						}
					}),
				localPlugins: managed.filter(isLocalBridge).map((server) => server.name),
				customPlugins: managed
					.filter(
						(server) => server.custom || (!localNames.has(server.name) && !presetNames.has(server.name)),
					)
					.map((server) => ({
						name: server.name,
						url: server.url,
						transport: server.transport,
						custom: true,
					})),
			},
			defaultPlugins: deps.pluginPresets,
			localStdioPlugins: deps.localPlugins,
		},
	}
}

export async function readCoworkSettings(deps: CoworkDependencies): Promise<CoworkAnswer> {
	try {
		return await readAnswer(deps)
	} catch (error) {
		return fail(500, messageOf(error, "Failed to read cowork settings"))
	}
}

/** The config body Cowork needs in order to route through this install. */
const buildConfig = (input: {
	baseUrl: string
	secret: string
	models: string[]
	servers: CoworkManagedServer[]
}): CoworkConfig => {
	const config: CoworkConfig = {
		...COWORK_SECURITY_RELAX,
		inferenceProvider: COWORK_PROVIDER,
		inferenceGatewayBaseUrl: input.baseUrl,
		inferenceGatewayApiKey: input.secret,
		inferenceModels: input.models.map((name) => ({ name })),
	}
	if (input.servers.length > 0) config.managedMcpServers = input.servers
	return config
}

export async function writeCoworkSettings(
	body: unknown,
	deps: CoworkDependencies,
): Promise<CoworkAnswer> {
	const { port } = deps
	try {
		const input = (body ?? {}) as {
			baseUrl?: unknown
			apiKey?: unknown
			models?: unknown
			plugins?: unknown
			localPlugins?: unknown
			customPlugins?: unknown
		}
		const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl : ""
		const secret = typeof input.apiKey === "string" ? input.apiKey : ""
		if (!baseUrl || !secret) return fail(400, "baseUrl and apiKey are required")

		const models = normaliseCoworkModels(input.models)
		if (models.length === 0) return fail(400, "At least one model is required")

		// An empty array means the user switched every plugin off; only `undefined` falls back to
		// the shipped defaults.
		const presets = Array.isArray(input.plugins) ? input.plugins : deps.pluginPresets
		const localNames = Array.isArray(input.localPlugins) ? input.localPlugins : []

		const servers = [
			...deps.buildPresetEntries(presets),
			...(await withAuth(bridgeEntries(localNames, deps), deps)),
			...(await withAuth(customEntries(normaliseCustomPlugins(input.customPlugins)), deps)),
		]

		const bootstrapped = await bootstrapDeploymentMode(port)
		const meta = await port.ensureMeta(port.writeMetaPath(), await port.metaPath())
		const configPath = `${port.writeConfigDir()}/${meta.appliedId}.json`
		await port.ensureDir(port.writeConfigDir())
		await port.writeText(
			configPath,
			JSON.stringify(buildConfig({ baseUrl, secret, models, servers }), null, 2),
		)

		// Each of these is best-effort and reported separately: the settings above are already
		// written, so a failure here must not turn a success into a 500.
		let skipApprovals: unknown
		try {
			skipApprovals = await writeSkipApprovals(port, servers)
		} catch (error) {
			skipApprovals = { error: messageOf(error, "could not write skip-approvals") }
		}
		try {
			await cleanupDesktopLegacy(
				port,
				deps.localPlugins.map((plugin) => plugin.name),
			)
		} catch {
			// The legacy entries are harmless; leaving them is better than failing the write.
		}

		return {
			status: 200,
			body: {
				success: true,
				bootstrapped,
				message: bootstrapped
					? "Cowork enabled (3p mode set). Quit & reopen Claude Desktop."
					: "Cowork settings applied. Quit & reopen Claude Desktop.",
				configPath,
				skipApprovals,
				localMcp: { applied: localNames, via: "3p-sse-bridge" },
			},
		}
	} catch (error) {
		return fail(500, messageOf(error, "Failed to apply cowork settings"))
	}
}

/**
 * Reset the active config.
 *
 * The file is emptied, not removed — see the note at the top of this file. A machine with no
 * library at all is already "reset", so it answers success rather than 404.
 */
export async function resetCoworkSettings(deps: CoworkDependencies): Promise<CoworkAnswer> {
	const { port } = deps
	try {
		const meta = await port.readJson<CoworkMeta>(await port.metaPath())
		if (!meta?.appliedId) {
			return { status: 200, body: { success: true, message: "No active config to reset" } }
		}
		const configPath = `${await port.configDir()}/${meta.appliedId}.json`
		const existing = await port.readText(configPath)
		if (existing !== null) await port.writeText(configPath, JSON.stringify({}, null, 2))

		try {
			await writeSkipApprovals(port, [])
		} catch {
			// Nothing to clear is the normal case here.
		}
		try {
			await cleanupDesktopLegacy(
				port,
				deps.localPlugins.map((plugin) => plugin.name),
			)
		} catch {
			// Same: a config that cannot be read has no legacy entries to remove.
		}
		return { status: 200, body: { success: true, message: "Cowork config reset" } }
	} catch (error) {
		return fail(500, messageOf(error, "Failed to reset cowork settings"))
	}
}
