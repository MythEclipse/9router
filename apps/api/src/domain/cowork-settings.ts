/**
 * What Claude Desktop's Cowork-mode config should contain after this screen has written it.
 *
 * The route mixed three kinds of decision: where the files live (host), how a request is read
 * (transport), and what the resulting config means (here). Only the last one is worth testing, and
 * it was the untested part — every bug this module's tests catch was previously only observable by
 * opening Claude Desktop and looking.
 */

/** The provider id Cowork should infer through. */
export const COWORK_PROVIDER = "gateway"

/**
 * Security relaxations applied on every save.
 *
 * These are not preferences — Cowork refuses to route inference through a third-party gateway
 * unless telemetry and the extension signature check are off, so they are part of the contract
 * rather than a default the operator could reasonably want to change.
 */
export const COWORK_SECURITY_RELAX = {
	coworkEgressAllowedHosts: ["*"],
	disabledBuiltinTools: [],
	isLocalDevMcpEnabled: true,
	isDesktopExtensionEnabled: true,
	isDesktopExtensionDirectoryEnabled: true,
	isDesktopExtensionSignatureRequired: false,
	isClaudeCodeForDesktopEnabled: true,
	disableEssentialTelemetry: true,
	disableNonessentialTelemetry: true,
	disableNonessentialServices: true,
} as const

/** One entry of `managedMcpServers`, as Cowork reads it back. */
export interface CoworkManagedServer {
	name: string
	url: string
	transport: string
	oauth?: boolean
	toolPolicy?: Record<string, string>
	custom?: boolean
	headers?: Record<string, string>
}

/** The subset of the Cowork config file this screen owns. */
export interface CoworkConfig {
	inferenceProvider?: string
	inferenceGatewayBaseUrl?: string
	inferenceGatewayApiKey?: string
	inferenceModels?: Array<string | { name?: string }>
	managedMcpServers?: CoworkManagedServer[]
	operonSkipMcpApprovals?: Record<string, boolean>
	[key: string]: unknown
}

/**
 * The model names Cowork will offer.
 *
 * Entries are `{name}` objects in the file but plain strings in the API, and older writes left the
 * string form behind; both are read so an existing config is not reported as having no models.
 */
export function readCoworkModels(config: CoworkConfig | null): string[] {
	if (!Array.isArray(config?.inferenceModels)) return []
	return config.inferenceModels
		.map((model) => (typeof model === "string" ? model : model?.name))
		.filter((name): name is string => typeof name === "string" && name.length > 0)
}

/** Whether the active config routes inference through this install. */
export function coworkHasThisInstall(config: CoworkConfig | null): boolean {
	return config?.inferenceProvider === COWORK_PROVIDER && !!config?.inferenceGatewayBaseUrl
}

/**
 * Accepts only the model names a save may write.
 *
 * Empty entries are dropped rather than refused one by one: the form sends `[""]` when the last
 * model is removed, and reporting that as a per-model error would blame the wrong thing.
 */
export function normaliseCoworkModels(models: unknown): string[] {
	if (!Array.isArray(models)) return []
	return models.filter((model): model is string => typeof model === "string" && !!model.trim())
}

/** A custom plugin, after the URL-only rule has been applied. */
export interface CoworkCustomPlugin {
	name: string
	url: string
	transport?: string
}

/**
 * Accepts only URL-backed custom plugins.
 *
 * A stdio `command` is dropped on purpose: this screen must never spawn a process from a text
 * field, so a plugin without a URL simply does not become a managed server.
 */
export function normaliseCustomPlugins(plugins: unknown): CoworkCustomPlugin[] {
	if (!Array.isArray(plugins)) return []
	const out: CoworkCustomPlugin[] = []
	for (const plugin of plugins) {
		const candidate = plugin as { name?: unknown; url?: unknown; transport?: unknown } | null
		if (typeof candidate?.name !== "string" || typeof candidate?.url !== "string") continue
		if (!candidate.name || !candidate.url) continue
		out.push({
			name: candidate.name,
			url: candidate.url,
			transport: typeof candidate.transport === "string" ? candidate.transport : undefined,
		})
	}
	return out
}

/**
 * The `operonSkipMcpApprovals` map for a set of managed servers.
 *
 * Cowork's schema wants explicit tool names and has no wildcard, so approvals are skipped per
 * server instead — one `true` per managed name.
 */
export function skipApprovalsFor(servers: CoworkManagedServer[]): Record<string, boolean> {
	const skip: Record<string, boolean> = {}
	for (const server of servers) {
		if (server?.name) skip[server.name] = true
	}
	return skip
}

/**
 * The tool names a saved plugin should show, stripping the `{name}-` prefix the writer adds.
 *
 * The prefix is written to match Cowork's runtime naming, so a naive read-back shows every tool
 * twice (`web_search_exa` and `exa-web_search_exa`) and a re-apply multiplies the list.
 */
export function bareToolNames(pluginName: string, policyKeys: string[]): string[] {
	const prefix = `${pluginName}-`
	const bare = new Set<string>()
	for (const key of policyKeys) {
		let tool = key
		while (tool.startsWith(prefix)) tool = tool.slice(prefix.length)
		bare.add(tool)
	}
	return [...bare]
}

/**
 * Adds this install's CLI token header to entries pointing at its own MCP bridge.
 *
 * Only own-bridge URLs get the token: sending it to a third-party MCP server would hand out a
 * credential that server never asked for.
 */
export function withInjectedAuth(
	servers: CoworkManagedServer[],
	options: { localBridgePrefix: string; cliTokenHeader: string; token: string },
): CoworkManagedServer[] {
	return servers.map((server) => {
		if (typeof server.url !== "string" || !server.url.startsWith(options.localBridgePrefix)) {
			return server
		}
		return {
			...server,
			headers: { ...(server.headers ?? {}), [options.cliTokenHeader]: options.token },
		}
	})
}
