/**
 * Which entries of Anthropic's MCP registry may be offered as a Cowork plugin.
 *
 * Cowork runs in 3p mode, so a server that expects to be brokered through claude.ai cannot be
 * reached from it at all. Offering one produces a plugin that fails on first use, which reads to
 * the operator as "9Router is broken" — so the filter is the feature, not a nicety.
 */

/** How long a fetched registry is trusted before it is fetched again. */
export const REGISTRY_CACHE_TTL_MS = 60 * 60 * 1000

/** One registry entry, as the screen lists it. */
export interface RegistryServer {
	name: string
	slug: string
	title: string
	description: string
	url: string
	transport: string
	oauth: boolean
	toolNames: string[]
	toolCount: number
	iconUrl: string | null
}

/**
 * Whether a registry server can be reached directly from 3p Cowork.
 *
 * Three refusals, each for a measured reason:
 * - `mcp.claude.com` and `api.anthropic.com/mcp` are brokered by Anthropic and are broken in 3p.
 * - A URL containing `<` or `{` is an unsubstituted template, not a URL.
 * - Anything that is not HTTPS is refused; a registry entry pointing at `http://` would send the
 *   key over plaintext.
 */
export function isDirectConnect(url: unknown): boolean {
	if (!url || typeof url !== "string") return false
	if (/^https?:\/\/[^/]*\bmcp\.claude\.com\b/i.test(url)) return false
	if (/^https?:\/\/api\.anthropic\.com\/mcp\b/i.test(url)) return false
	if (/[<{]/.test(url)) return false
	return /^https:\/\//i.test(url)
}

/**
 * Whether an entry needs fields this screen cannot collect.
 *
 * A tenant-required server wants an identifier the operator would have to know; the form has no
 * field for it, so offering the plugin would produce an entry that cannot authenticate.
 */
export function needsUncollectedFields(requiredFields: unknown): boolean {
	return Array.isArray(requiredFields) && requiredFields.length > 0
}

/** Turns one raw registry item into a server, or null when it must not be offered. */
export function toRegistryServer(item: unknown): RegistryServer | null {
	const raw = item as {
		server?: Record<string, unknown>
		_meta?: Record<string, unknown>
	} | null
	const server = (raw?.server ?? {}) as Record<string, unknown>
	const meta =
		((raw?._meta?.["com.anthropic.api/mcp-registry"] ?? {}) as Record<string, unknown>) ?? {}

	const remote = ((server.remotes as Array<Record<string, unknown>> | undefined) ?? [])[0]
	const url = remote?.url
	if (!isDirectConnect(url)) return null
	if (needsUncollectedFields(meta.requiredFields)) return null

	const toolNames = Array.isArray(meta.toolNames)
		? meta.toolNames.filter((name): name is string => typeof name === "string")
		: []
	const name = String(server.name ?? "")
	if (!name) return null

	return {
		name,
		slug: typeof meta.slug === "string" ? meta.slug : name,
		title:
			typeof server.title === "string"
				? server.title
				: typeof meta.displayName === "string"
					? meta.displayName
					: name,
		description:
			typeof server.description === "string"
				? server.description
				: typeof meta.oneLiner === "string"
					? meta.oneLiner
					: "",
		url: String(url),
		transport: remote?.type === "sse" ? "sse" : "http",
		oauth: !meta.isAuthless,
		toolNames,
		toolCount: toolNames.length,
		iconUrl: typeof meta.iconUrl === "string" ? meta.iconUrl : null,
	}
}

/** Drops duplicates by URL, keeping the first — the registry returns the same server twice. */
export function dedupeByUrl(servers: RegistryServer[]): RegistryServer[] {
	const seen = new Set<string>()
	return servers.filter((server) => (seen.has(server.url) ? false : (seen.add(server.url), true)))
}
