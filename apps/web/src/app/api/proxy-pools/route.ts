import { NextResponse } from "next/server"
import { isSupportedProxyScheme } from "@/lib/network/outboundProxy"
import { createProxyPool, getProviderConnections, getProxyPools } from "@/models"
import type { Connection } from "@/shared/types/domain"

export const dynamic = "force-dynamic"

function toBoolean(value) {
	if (value === "true") return true
	if (value === "false") return false
	return undefined
}

const VALID_PROXY_TYPES = ["http", "vercel", "cloudflare", "deno", "netlify"]

/** The writable fields of a proxy pool, as accepted by the API. */
interface ProxyPoolInput {
	name: string
	proxyUrl: string
	noProxy: string
	isActive: boolean
	strictProxy: boolean
	type: string
}

function normalizeProxyPoolInput(
	body: Record<string, unknown> = {},
): ProxyPoolInput | { error: string } {
	const name = typeof body?.name === "string" ? body.name.trim() : ""
	const proxyUrl = typeof body?.proxyUrl === "string" ? body.proxyUrl.trim() : ""
	const noProxy = typeof body?.noProxy === "string" ? body.noProxy.trim() : ""
	const isActive = body?.isActive === undefined ? true : body.isActive === true
	const strictProxy = body?.strictProxy === true
	const requestedType = typeof body?.type === "string" ? body.type : ""
	const type = VALID_PROXY_TYPES.includes(requestedType) ? requestedType : "http"

	if (!name) {
		return { error: "Name is required" }
	}

	if (!proxyUrl) {
		return { error: "Proxy URL is required" }
	}

	// Reject at configuration time what the runtime cannot dial. A pool saved with
	// a socks URL would answer every request with UnsupportedProxyProtocol while
	// the no-leak policy blocks the direct fallback — a permanently dead pool that
	// the dashboard reports healthy.
	if (!isSupportedProxyScheme(proxyUrl)) {
		return {
			error:
				"Proxy URL must use http:// or https:// — socks proxies are not supported by the serving runtime",
		}
	}

	return { name, proxyUrl, noProxy, isActive, strictProxy, type }
}

function buildUsageMap(connections: Connection[] = []) {
	const usageMap = new Map<string, number>()

	for (const connection of connections) {
		const providerSpecificData = connection?.providerSpecificData as
			| Record<string, unknown>
			| null
			| undefined
		const proxyPoolId = providerSpecificData?.proxyPoolId
		if (typeof proxyPoolId !== "string" || !proxyPoolId) continue

		usageMap.set(proxyPoolId, (usageMap.get(proxyPoolId) || 0) + 1)
	}

	return usageMap
}

// GET /api/proxy-pools - List proxy pools
export async function GET(request) {
	try {
		const { searchParams } = new URL(request.url)
		const isActive = toBoolean(searchParams.get("isActive"))
		const includeUsage = searchParams.get("includeUsage") === "true"

		const filter: { isActive?: boolean } = {}
		if (isActive !== undefined) {
			filter.isActive = isActive
		}

		const proxyPools = await getProxyPools(filter)

		if (!includeUsage) {
			return NextResponse.json({ proxyPools })
		}

		const connections = await getProviderConnections()
		const usageMap = buildUsageMap(connections)

		const enrichedProxyPools = proxyPools.map((pool) => ({
			...pool,
			boundConnectionCount: usageMap.get(pool.id) || 0,
		}))

		return NextResponse.json({ proxyPools: enrichedProxyPools })
	} catch (error) {
		console.log("Error fetching proxy pools:", error)
		return NextResponse.json({ error: "Failed to fetch proxy pools" }, { status: 500 })
	}
}

// POST /api/proxy-pools - Create proxy pool
export async function POST(request) {
	try {
		const body = await request.json()
		const normalized = normalizeProxyPoolInput(body)

		if ("error" in normalized) {
			return NextResponse.json({ error: normalized.error }, { status: 400 })
		}

		const proxyPool = await createProxyPool({ ...normalized })
		return NextResponse.json({ proxyPool }, { status: 201 })
	} catch (error) {
		console.log("Error creating proxy pool:", error)
		return NextResponse.json({ error: "Failed to create proxy pool" }, { status: 500 })
	}
}
