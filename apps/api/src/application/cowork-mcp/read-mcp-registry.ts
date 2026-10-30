/**
 * The Cowork MCP registry, walked and cached.
 *
 * The registry is a paginated Anthropic endpoint; `domain/cowork-mcp-registry` already decides
 * which entries are usable and how duplicates collapse. This file is the walk plus the cache,
 * and the cache is the interesting part:
 *
 * - it is keyed on the process, not the request, because one dashboard asks for this list from
 *   several screens and the registry is a third party;
 * - a failed walk reports the error and answers an empty list, without overwriting what is
 *   already cached — so one bad refresh does not empty the screen for the next request.
 */

import {
	dedupeByUrl,
	REGISTRY_CACHE_TTL_MS,
	type RegistryServer,
	toRegistryServer,
} from "../../domain/cowork-mcp-registry.ts"

const REGISTRY_URL = "https://api.anthropic.com/mcp-registry/v0/servers"
const VISIBILITY = "commercial,gsuite,gsuite-google"
/** Bounds the walk even if the registry keeps handing back a cursor. */
const MAX_PAGES = 20

/** The list as the screen receives it. */
export interface RegistryPage {
	readonly servers: RegistryServer[]
	readonly total: number
}

/** A flat answer, matching the other CLI-tool answers. */
export interface RegistryAnswer {
	readonly status: number
	readonly body: Record<string, unknown>
}

/** The cache as the host keeps it; injected so a test can start from empty. */
export interface RegistryCache {
	ts: number
	data: RegistryPage | null
}

/** One walk over the registry, keeping only entries the domain rule accepts. */
export async function fetchRegistry(fetchServers: typeof fetch): Promise<RegistryServer[]> {
	const out: RegistryServer[] = []
	let cursor = ""

	for (let page = 0; page < MAX_PAGES; page++) {
		const url = `${REGISTRY_URL}?limit=500&visibility=${VISIBILITY}${
			cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
		}`
		const response = await fetchServers(url, { headers: { accept: "application/json" } })
		// A failing page ends the walk rather than failing it: whatever was collected is a
		// usable list, and a half-filled registry screen beats an error one.
		if (!response.ok) break

		const body = (await response.json()) as {
			servers?: unknown[]
			metadata?: { nextCursor?: string }
		}
		for (const item of body.servers ?? []) {
			const server = toRegistryServer(item)
			if (server) out.push(server)
		}

		// A page without a next cursor is the last page; stopping here keeps the loop bounded
		// even when the registry keeps answering.
		cursor = body.metadata?.nextCursor ?? ""
		if (!cursor) break
	}

	return dedupeByUrl(out)
}

/**
 * The list, from cache when it is fresh.
 *
 * `refresh` skips the freshness check but not the fetch: a forced refresh that fails still
 * reports the error, and still leaves the cached list intact for the next screen that asks.
 */
export async function readMcpRegistry(
	options: {
		readonly cache: RegistryCache
		readonly fetchServers: typeof fetch
		readonly now?: () => number
	},
	refresh: boolean,
): Promise<RegistryAnswer> {
	const now = options.now ?? Date.now
	const { cache } = options

	if (!refresh && cache.data && now() - cache.ts < REGISTRY_CACHE_TTL_MS) {
		return { status: 200, body: { cached: true, ...cache.data } }
	}

	try {
		const servers = await fetchRegistry(options.fetchServers)
		const data: RegistryPage = { servers, total: servers.length }
		cache.ts = now()
		cache.data = data
		return { status: 200, body: { cached: false, ...data } }
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error"
		return { status: 500, body: { error: message, servers: [], total: 0 } }
	}
}
