import { NextResponse } from "next/server"
import {
	deleteProxyPool,
	getProviderConnections,
	getProxyPoolById,
	updateProxyPool,
} from "@/models"
import type { Connection } from "@/shared/types/domain"

export const dynamic = "force-dynamic"

const VALID_PROXY_TYPES = ["http", "vercel", "cloudflare", "deno", "netlify"]

/** The subset of a proxy pool a PUT may change; only present keys are written. */
interface ProxyPoolUpdates {
	name?: string
	proxyUrl?: string
	noProxy?: string
	isActive?: boolean
	strictProxy?: boolean
	type?: string
	[key: string]: unknown
}

function normalizeProxyPoolUpdate(
	body: Record<string, unknown> = {},
): ProxyPoolUpdates | { error: string } {
	const updates: ProxyPoolUpdates = {}

	if (Object.hasOwn(body, "name")) {
		const name = typeof body?.name === "string" ? body.name.trim() : ""
		if (!name) {
			return { error: "Name is required" }
		}
		updates.name = name
	}

	if (Object.hasOwn(body, "proxyUrl")) {
		const proxyUrl = typeof body?.proxyUrl === "string" ? body.proxyUrl.trim() : ""
		if (!proxyUrl) {
			return { error: "Proxy URL is required" }
		}
		updates.proxyUrl = proxyUrl
	}

	if (Object.hasOwn(body, "noProxy")) {
		updates.noProxy = typeof body?.noProxy === "string" ? body.noProxy.trim() : ""
	}

	if (Object.hasOwn(body, "isActive")) {
		updates.isActive = body?.isActive === true
	}

	if (Object.hasOwn(body, "strictProxy")) {
		updates.strictProxy = body?.strictProxy === true
	}

	if (Object.hasOwn(body, "type")) {
		const requestedType = typeof body?.type === "string" ? body.type : ""
		updates.type = VALID_PROXY_TYPES.includes(requestedType) ? requestedType : "http"
	}

	return updates
}

function countBoundConnections(connections: Connection[] = [], proxyPoolId: string) {
	return connections.filter(
		(connection) =>
			(connection?.providerSpecificData as Record<string, unknown> | null | undefined)?.proxyPoolId ===
			proxyPoolId,
	).length
}

// GET /api/proxy-pools/[id] - Get proxy pool
export async function GET(_request, { params }) {
	try {
		const { id } = await params
		const proxyPool = await getProxyPoolById(id)

		if (!proxyPool) {
			return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 })
		}

		return NextResponse.json({ proxyPool })
	} catch (error) {
		console.log("Error fetching proxy pool:", error)
		return NextResponse.json({ error: "Failed to fetch proxy pool" }, { status: 500 })
	}
}

// PUT /api/proxy-pools/[id] - Update proxy pool
export async function PUT(request, { params }) {
	try {
		const { id } = await params
		const existing = await getProxyPoolById(id)

		if (!existing) {
			return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 })
		}

		const body = await request.json()
		const normalized = normalizeProxyPoolUpdate(body)

		if ("error" in normalized) {
			return NextResponse.json({ error: normalized.error }, { status: 400 })
		}

		const updated = await updateProxyPool(id, normalized)
		return NextResponse.json({ proxyPool: updated })
	} catch (error) {
		console.log("Error updating proxy pool:", error)
		return NextResponse.json({ error: "Failed to update proxy pool" }, { status: 500 })
	}
}

// DELETE /api/proxy-pools/[id] - Delete proxy pool
export async function DELETE(_request, { params }) {
	try {
		const { id } = await params
		const existing = await getProxyPoolById(id)

		if (!existing) {
			return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 })
		}

		const connections = await getProviderConnections()
		const boundConnectionCount = countBoundConnections(connections, id)

		if (boundConnectionCount > 0) {
			return NextResponse.json(
				{
					error: "Proxy pool is currently in use",
					boundConnectionCount,
				},
				{ status: 409 },
			)
		}

		await deleteProxyPool(id)
		return NextResponse.json({ success: true })
	} catch (error) {
		console.log("Error deleting proxy pool:", error)
		return NextResponse.json({ error: "Failed to delete proxy pool" }, { status: 500 })
	}
}
