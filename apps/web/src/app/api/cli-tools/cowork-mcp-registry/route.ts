import {
	dedupeByUrl,
	REGISTRY_CACHE_TTL_MS,
	type RegistryServer,
	toRegistryServer,
} from "9router-api/domain/cowork-mcp-registry"
import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

const REGISTRY_URL = "https://api.anthropic.com/mcp-registry/v0/servers"
const VISIBILITY = "commercial,gsuite,gsuite-google"
const MAX_PAGES = 20
const CACHE_KEY = "__9routerCoworkMcpRegistryCache"

interface RegistryCacheEntry {
	ts: number
	data: { servers: RegistryServer[]; total: number } | null
}

function registryCache(): RegistryCacheEntry {
	const store = globalThis as unknown as Record<string, unknown>
	if (!store[CACHE_KEY]) store[CACHE_KEY] = { ts: 0, data: null } satisfies RegistryCacheEntry
	return store[CACHE_KEY] as RegistryCacheEntry
}

/** Walks the registry's cursor pages, keeping only entries the domain rule accepts. */
async function fetchRegistry(): Promise<RegistryServer[]> {
	const out: RegistryServer[] = []
	let cursor = ""

	for (let page = 0; page < MAX_PAGES; page++) {
		const url = `${REGISTRY_URL}?limit=500&visibility=${VISIBILITY}${
			cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
		}`
		const response = await fetch(url, { headers: { accept: "application/json" } })
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

export async function GET(request: Request) {
	const force = new URL(request.url).searchParams.get("refresh") === "1"
	const cache = registryCache()
	if (!force && cache.data && Date.now() - cache.ts < REGISTRY_CACHE_TTL_MS) {
		return NextResponse.json({ cached: true, ...cache.data })
	}

	try {
		const servers = await fetchRegistry()
		const data = { servers, total: servers.length }
		cache.ts = Date.now()
		cache.data = data
		return NextResponse.json({ cached: false, ...data })
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error"
		return NextResponse.json({ error: message, servers: [], total: 0 }, { status: 500 })
	}
}
