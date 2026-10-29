/**
 * Provider connections: list, create, read, update, delete.
 *
 * The create route copied a compatible node's fields into
 * `providerSpecificData` in three near-identical branches — one for
 * OpenAI-compatible, one for Anthropic-compatible, one for custom-embedding —
 * differing only in which keys were copied. The third branch forgot
 * `quotaEnabled`/`quotaPath`, so a custom embedding node's connection lost its
 * quota settings and the usage panel showed nothing for it.
 *
 * The branches are now one function that copies what the node has, and the
 * proxy rules come from `domain/provider-connection.ts` so create and update
 * agree on what an absent field means.
 */

import { conflict, invalid, notFound } from "../../domain/errors.ts"
import {
	applyProxyConfig,
	applyProxyPoolChoice,
	applyWriteOnlySecret,
	chooseConnectionName,
	nextKeyOrdinal,
	readProxyConfig,
	readProxyPoolChoice,
	readWriteOnlySecret,
} from "../../domain/provider-connection.ts"
import type {
	ConnectionFields,
	ConnectionNode,
	ConnectionNodeStore,
	ConnectionStore,
	ProviderCatalogue,
	ProxyPoolStore,
	StoredConnection,
} from "./ports.ts"

export interface ConnectionDependencies {
	readonly connections: ConnectionStore
	readonly nodes: ConnectionNodeStore
	readonly pools: ProxyPoolStore
	readonly catalogue: ProviderCatalogue
	/** Normalises a provider id — the dashboard sends several spellings of each. */
	readonly normalizeProviderId: (provider: unknown) => string
	/** Merges provider-specific defaults a request body implies. */
	readonly normalizeProviderSpecificData: (
		provider: string,
		body: Record<string, unknown>,
		providerSpecificData: unknown,
	) => Record<string, unknown>
	/** Strips secrets before a connection leaves the process. */
	readonly toResponse: (connection: StoredConnection) => Record<string, unknown>
}

/**
 * What a compatible node contributes to the connection that points at it.
 *
 * `apiType` is only meaningful for an OpenAI-compatible node — it is the request
 * shape the node speaks. The node row carries the field whatever its kind, so it
 * is copied only where the router will read it.
 */
function nodeFields(
	node: ConnectionNode,
	options: { readonly includeQuota: boolean; readonly includeApiType: boolean },
): Record<string, unknown> {
	return {
		prefix: node.prefix,
		...(options.includeApiType ? { apiType: node.apiType } : {}),
		baseUrl: node.baseUrl,
		nodeName: node.name,
		...(options.includeQuota
			? { quotaEnabled: node.quotaEnabled === true, quotaPath: node.quotaPath || "/credits" }
			: {}),
	}
}

type NodeKind = "openai-compatible" | "anthropic-compatible" | "custom-embedding"

const NODE_LABELS: Record<NodeKind, string> = {
	"openai-compatible": "OpenAI Compatible",
	"anthropic-compatible": "Anthropic Compatible",
	"custom-embedding": "Custom Embedding",
}

export function makeConnections({
	connections,
	nodes,
	pools,
	catalogue,
	normalizeProviderId,
	normalizeProviderSpecificData,
	toResponse,
}: ConnectionDependencies) {
	/**
	 * Which node kind this provider is, if any.
	 *
	 * A provider is at most one of these; checking in one place keeps the create
	 * path from growing a fourth branch when a new kind arrives.
	 */
	function nodeKindOf(provider: string): NodeKind | null {
		if (catalogue.isOpenAICompatible(provider)) return "openai-compatible"
		if (catalogue.isAnthropicCompatible(provider)) return "anthropic-compatible"
		if (catalogue.isCustomEmbedding(provider)) return "custom-embedding"
		return null
	}

	async function requireNode(provider: string, kind: NodeKind): Promise<ConnectionNode> {
		const node = await nodes.find(provider)
		if (!node) throw notFound(`${NODE_LABELS[kind]} node`)
		return node
	}

	/** The proxy pool id, once confirmed to name a pool that exists. */
	async function resolveProxyPool(value: unknown): Promise<unknown> {
		const choice = readProxyPoolChoice(value)
		if (choice.kind !== "set") return value
		if (!(await pools.exists(choice.proxyPoolId))) {
			throw invalid("Proxy pool not found")
		}
		return choice.proxyPoolId
	}

	return {
		/**
		 * Every connection, with compatible ones named after their node.
		 *
		 * A failed node read is not fatal: the listing still works, the compatible
		 * names just fall back to the raw provider id.
		 */
		async list(): Promise<Array<Record<string, unknown>>> {
			const stored = await connections.list()
			const nodeNames = new Map<string, string>()
			try {
				for (const node of await nodes.list()) {
					if (node.id && node.name) nodeNames.set(node.id, node.name)
				}
			} catch (error) {
				console.error("Failed to load provider nodes for names:", error)
			}

			return stored.map((connection) => {
				const safe = toResponse(connection)
				const kind = nodeKindOf(connection.provider)
				if (!kind) return safe

				const storedNodeName = connection.providerSpecificData?.nodeName
				const name =
					connection.name ||
					nodeNames.get(connection.provider) ||
					(typeof storedNodeName === "string" ? storedNodeName : "") ||
					connection.provider
				return { ...safe, name }
			})
		},

		async get(id: string): Promise<Record<string, unknown>> {
			const connection = await connections.find(id)
			if (!connection) throw notFound("Connection")
			return toResponse(connection)
		},

		/**
		 * Add a connection.
		 *
		 * A POST carrying an `id` is an edit of that connection, so overwriting is
		 * allowed; without one, a name collision is refused rather than silently
		 * replacing a key the operator cannot get back.
		 */
		async create(body: Record<string, unknown>): Promise<Record<string, unknown>> {
			const provider = normalizeProviderId(body.provider)
			const { apiKey, name, displayName, priority, globalPriority, defaultModel, testStatus } = body

			const proxyConfig = readProxyConfig(body)
			if (proxyConfig.kind === "invalid") throw invalid(proxyConfig.message)

			const proxyPoolId = await resolveProxyPool(body.proxyPoolId)
			const proxyPoolChoice = readProxyPoolChoice(proxyPoolId)

			if (!provider || !catalogue.isCreatable(provider)) throw invalid("Invalid provider")

			const isWebCookie = catalogue.isWebCookie(provider)
			const substituteField = catalogue.apiKeySubstituteField(provider)
			const providerSpecificDataIn = body.providerSpecificData
			const hasSubstitute = !!(
				substituteField &&
				providerSpecificDataIn &&
				typeof providerSpecificDataIn === "object" &&
				(providerSpecificDataIn as Record<string, unknown>)[substituteField]
			)
			if (!apiKey && provider !== "ollama-local" && !hasSubstitute) {
				throw invalid(`${isWebCookie ? "Cookie value" : "API Key"} is required`)
			}

			const ordinal = nextKeyOrdinal(
				await connections.list({ provider }),
				typeof apiKey === "string" ? apiKey : null,
			)
			const connectionName = chooseConnectionName({
				name,
				displayName,
				providerLabel: catalogue.label(provider),
				ordinal,
			})

			let providerSpecificData = normalizeProviderSpecificData(provider, body, providerSpecificDataIn)

			const kind = nodeKindOf(provider)
			if (kind) {
				const node = await requireNode(provider, kind)
				// A custom embedding node carries no quota settings — the usage panel
				// reads quota from the node, and an embedding node has none to read.
				providerSpecificData = nodeFields(node, {
					includeQuota: kind !== "custom-embedding",
					includeApiType: kind === "openai-compatible",
				})
			}

			let merged = applyProxyConfig(providerSpecificData, proxyConfig)
			merged = applyProxyPoolChoice(merged, proxyPoolChoice)

			const created = await connections.create({
				provider,
				authType: isWebCookie ? "cookie" : "apikey",
				name: connectionName,
				apiKey: typeof apiKey === "string" ? apiKey : "",
				priority: typeof priority === "number" ? priority : 1,
				globalPriority: typeof globalPriority === "number" ? globalPriority : null,
				defaultModel: typeof defaultModel === "string" ? defaultModel : null,
				providerSpecificData: merged,
				isActive: true,
				testStatus: typeof testStatus === "string" ? testStatus : "unknown",
				allowOverwrite: body.id ? true : body.allowOverwrite === true || body.overwrite === true,
			})

			return toResponse(created)
		},

		/**
		 * Update a connection.
		 *
		 * Every field is optional, and "absent" means "leave it alone" — including
		 * the proxy and pool fields, which is why the domain rule distinguishes it
		 * from "sent empty".
		 */
		async update(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
			const existing = await connections.find(id)
			if (!existing) throw notFound("Connection")

			const proxyConfig = readProxyConfig(body)
			if (proxyConfig.kind === "invalid") throw invalid(proxyConfig.message)

			const proxyPoolId = await resolveProxyPool(body.proxyPoolId)
			const proxyPoolChoice = readProxyPoolChoice(proxyPoolId)

			const fields: Record<string, unknown> = {}
			for (const key of [
				"name",
				"priority",
				"globalPriority",
				"defaultModel",
				"isActive",
				"testStatus",
				"lastError",
				"lastErrorAt",
			]) {
				if (body[key] !== undefined) fields[key] = body[key]
			}
			// Only an API-key connection has a key to replace; an OAuth row's
			// `apiKey` is a token the refresh flow owns.
			if (body.apiKey && existing.authType === "apikey") fields.apiKey = body.apiKey

			const touchesProviderData =
				existing.providerSpecificData !== undefined ||
				body.providerSpecificData !== undefined ||
				proxyConfig.kind === "set" ||
				proxyPoolChoice.kind !== "absent"

			if (touchesProviderData) {
				const incoming = {
					...((body.providerSpecificData as Record<string, unknown> | undefined) ?? {}),
				}
				let merged: Record<string, unknown> = {
					...(existing.providerSpecificData ?? {}),
					...incoming,
				}
				// The AWS session token is write-only: the form sends it blank on
				// every edit because it cannot read it back. The rule has to read the
				// *incoming* field and then decide against the stored map — reading it
				// after the merge would see only the blank that already won.
				if (catalogue.usesAwsCredentialForm(existing.provider)) {
					const stored = { ...(existing.providerSpecificData ?? {}) }
					merged = applyWriteOnlySecret(
						stored,
						"sessionToken",
						readWriteOnlySecret(incoming.sessionToken),
					)
					const { sessionToken: _token, ...rest } = incoming
					merged = { ...merged, ...rest }
				}
				merged = applyProxyConfig(merged, proxyConfig)
				merged = applyProxyPoolChoice(merged, proxyPoolChoice)
				fields.providerSpecificData = merged
			}

			const updated = await connections.update(id, fields as Partial<ConnectionFields>)
			if (!updated) throw notFound("Connection")
			return toResponse(updated)
		},

		async remove(id: string): Promise<{ readonly removed: true }> {
			const removed = await connections.remove(id)
			if (!removed) throw notFound("Connection")
			return { removed: true }
		},

		/** Exposed so the web layer can report a name collision as 409. */
		isNameConflict(error: unknown): boolean {
			return (
				typeof error === "object" &&
				error !== null &&
				(error as { code?: unknown }).code === "PROVIDER_NAME_CONFLICT"
			)
		},

		nameConflict(error: unknown): never {
			const details = error as { message?: string; existingId?: string; existingName?: string }
			throw conflict(details.message ?? "A connection with that name already exists")
		},
	}
}

export type Connections = ReturnType<typeof makeConnections>
