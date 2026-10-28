import { NextResponse } from "next/server"
import { getProviderConnections } from "@/lib/localDb"
import { backfillCodexEmails } from "@/lib/oauth/providers"
import { getProviderNodes } from "@/models"
import {
	isAnthropicCompatibleProvider,
	isOpenAICompatibleProvider,
	USAGE_APIKEY_PROVIDERS,
	USAGE_SUPPORTED_PROVIDERS,
} from "@/shared/constants/providers"
import type { Connection, ProviderNode } from "@/shared/types/domain"

export const dynamic = "force-dynamic"

const SAFE_FIELDS = [
	"id",
	"provider",
	"authType",
	"name",
	"email",
	"displayName",
	"priority",
	"globalPriority",
	"isActive",
	"defaultModel",
	"testStatus",
	"lastError",
	"lastErrorAt",
	"errorCode",
	"expiresAt",
	"lastUsedAt",
	"consecutiveUseCount",
	"createdAt",
	"updatedAt",
]

const SAFE_PSD_FIELDS = [
	"baseUrl",
	"azureEndpoint",
	"deployment",
	"apiVersion",
	"accountId",
	"region",
	"projectId",
	"resourceUrl",
	"proxyPoolId",
	"connectionProxyEnabled",
	"connectionProxyUrl",
	"connectionNoProxy",
	"githubLogin",
	"githubName",
	"githubEmail",
	"githubUserId",
	"username",
	"firstName",
	"lastName",
	"authMethod",
	"authKind",
	"profileArn",
	"nodeName",
	"quotaEnabled",
	"quotaPath",
]

const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 500

function maskName(name: string) {
	if (typeof name !== "string" || name.length <= 16) return name
	if (/[a-zA-Z0-9_-]{32,}/.test(name)) return `${name.slice(0, 8)}***`
	return name
}

/** The subset of a connection the client-facing listing is allowed to expose. */
interface SanitizedConnection {
	[key: string]: unknown
}

function sanitize(c: Connection): SanitizedConnection {
	const safe: SanitizedConnection = {}
	for (const f of SAFE_FIELDS) if (c[f] !== undefined) safe[f] = c[f]
	if (typeof safe.name === "string") safe.name = maskName(safe.name)
	const psd = c.providerSpecificData as Record<string, unknown> | null | undefined
	if (psd) {
		const safePsd: Record<string, unknown> = {}
		for (const f of SAFE_PSD_FIELDS) {
			if (psd[f] !== undefined) safePsd[f] = psd[f]
		}
		safe.providerSpecificData = safePsd
	}
	return safe
}

function isUsageEligible(connection: Connection, nodeById: Map<string, ProviderNode>) {
	if (
		isOpenAICompatibleProvider(connection.provider) ||
		isAnthropicCompatibleProvider(connection.provider)
	) {
		return nodeById.get(connection.provider)?.quotaEnabled === true
	}
	return (
		USAGE_SUPPORTED_PROVIDERS.includes(connection.provider) &&
		(connection.authType === "oauth" || USAGE_APIKEY_PROVIDERS.includes(connection.provider))
	)
}

function parsePositiveInt(value: string | null, fallback: number) {
	const parsed = Number.parseInt(String(value ?? ""), 10)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function sortConnections(connections: Connection[], sort: string | null) {
	const list = [...connections]

	if (sort === "provider") {
		return list.sort((a, b) => {
			const orderA = USAGE_SUPPORTED_PROVIDERS.indexOf(a.provider)
			const orderB = USAGE_SUPPORTED_PROVIDERS.indexOf(b.provider)
			if (orderA !== orderB) return orderA - orderB
			return a.provider.localeCompare(b.provider)
		})
	}

	return list.sort((a, b) => {
		const priorityA = Number(a.priority ?? Number.MAX_SAFE_INTEGER)
		const priorityB = Number(b.priority ?? Number.MAX_SAFE_INTEGER)
		if (priorityA !== priorityB) return priorityA - priorityB
		return (a.provider || "").localeCompare(b.provider || "")
	})
}

export async function GET(request) {
	try {
		await backfillCodexEmails()

		const { searchParams } = new URL(request.url)
		const provider = searchParams.get("provider") || "all"
		const accountStatus = searchParams.get("accountStatus") || "all"
		const sort = searchParams.get("sort") || "priority"
		const page = parsePositiveInt(searchParams.get("page"), 1)
		const pageSize = Math.min(
			parsePositiveInt(searchParams.get("pageSize"), DEFAULT_PAGE_SIZE),
			MAX_PAGE_SIZE,
		)

		const allConnections = await getProviderConnections()
		const nodes = await getProviderNodes()
		const nodeById = new Map<string, ProviderNode>(
			nodes.map((node) => [String(node.id), node as ProviderNode]),
		)
		const eligibleConnections = allConnections.filter((conn) =>
			isUsageEligible(conn as Connection, nodeById),
		)
		const providerOptions = Array.from(
			new Set(eligibleConnections.map((conn) => String(conn.provider))),
		).sort()

		const providerFilteredConnections = eligibleConnections.filter(
			(conn) => provider === "all" || conn.provider === provider,
		)

		const accountFilteredConnections = providerFilteredConnections.filter((conn) => {
			if (accountStatus === "active") return conn.isActive ?? true
			if (accountStatus === "inactive") return !(conn.isActive ?? true)
			return true
		})

		const sortedConnections = sortConnections(accountFilteredConnections, sort)
		const total = sortedConnections.length
		const totalPages = Math.max(1, Math.ceil(total / pageSize))
		const currentPage = Math.min(page, totalPages)
		const offset = (currentPage - 1) * pageSize
		const pageConnections = sortedConnections.slice(offset, offset + pageSize).map(sanitize)

		return NextResponse.json({
			connections: pageConnections,
			providerOptions,
			pagination: {
				page: currentPage,
				pageSize,
				total,
				totalPages,
			},
			totals: {
				eligibleConnections: eligibleConnections.length,
				providerFilteredConnections: providerFilteredConnections.length,
			},
		})
	} catch (error) {
		console.log("Error fetching providers for client:", error)
		return NextResponse.json({ error: "Failed to fetch providers" }, { status: 500 })
	}
}
