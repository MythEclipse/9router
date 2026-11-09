/** Cowork settings: shared helpers. */
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
	skipApprovalsFor,
	withInjectedAuth,
} from "../../domain/cowork-settings.ts"
import type {
	CoworkAnswer,
	CoworkDependencies,
	CoworkFilesPort,
	CoworkLocalPlugin,
	CoworkMeta,
	CoworkPluginPreset,
} from "./cowork-types.ts"

export type {
	CoworkAnswer,
	CoworkDependencies,
	CoworkFilesPort,
	CoworkLocalPlugin,
	CoworkMeta,
	CoworkPluginPreset,
} from "./cowork-types.ts"

export const fail = (status: number, message: string): CoworkAnswer => ({
	status,
	body: { error: message },
})

export const messageOf = (error: unknown, fallback: string): string =>
	error instanceof Error ? error.message : fallback

/** Entries pointing at this app's own bridge carry the CLI token, or the bridge rejects them. */
export const withAuth = async (
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
export const bridgeEntries = (names: unknown, deps: CoworkDependencies): CoworkManagedServer[] => {
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
export const customEntries = (plugins: CoworkCustomPlugin[]): CoworkManagedServer[] =>
	plugins.map((plugin) => ({
		name: plugin.name,
		url: plugin.url,
		transport: plugin.transport || "sse",
		custom: true,
	}))

/** Cowork only reads configs written in 3p mode, so this runs before every write. */
export const bootstrapDeploymentMode = async (port: CoworkFilesPort): Promise<boolean> => {
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
export const cleanupDesktopLegacy = async (
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
export const writeSkipApprovals = async (
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
/** The config body Cowork needs in order to route through this install. */
export const buildConfig = (input: {
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
