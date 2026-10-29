/**
 * Provider nodes: compatible OpenAI/Anthropic/embedding endpoints an operator
 * adds by hand.
 *
 * The four endpoints that manage nodes had drifted apart, and the rules that
 * settle those differences live in `domain/provider-node.ts`. What matters at
 * this layer is the write ordering:
 *
 * A node's id is its provider id, and its connections carry a *copy* of the
 * node's prefix, base URL and quota settings in `providerSpecificData`. Updating
 * the node alone leaves every connection routing to the old prefix, so the
 * update patches both, and it does so with the values it just wrote rather than
 * re-deriving them from the request (`quotaEnabled` is preserved when the client
 * does not send it, and a re-derive would flip it).
 */
import { conflict, invalid, notFound } from "../../domain/errors.ts"
import {
	CUSTOM_EMBEDDING,
	DEFAULT_BASE_URLS,
	findDuplicate,
	isProviderNodeType,
	OPENAI_COMPATIBLE,
	sanitizeBaseUrl,
	sanitizeQuotaPath,
	validateApiType,
	validateNodeFields,
} from "../../domain/provider-node.ts"
import type { ProviderConnectionPort, ProviderNodePort, ProviderNodeRow } from "./ports.ts"

export interface ProviderNodeDependencies {
	readonly nodes: ProviderNodePort
	readonly connections: ProviderConnectionPort
	readonly normalizeLogo: (value: unknown) => string | null | undefined
	readonly generateId: () => string
	readonly prefixes: {
		openaiCompatible: string
		anthropicCompatible: string
		customEmbedding: string
	}
}

/** The node id prefix each type uses, so a node stays identifiable by its id. */
function idPrefix(type: string, deps: ProviderNodeDependencies): string {
	if (type === CUSTOM_EMBEDDING) return deps.prefixes.customEmbedding
	if (type === "anthropic-compatible") return deps.prefixes.anthropicCompatible
	return deps.prefixes.openaiCompatible
}

function refuseDuplicate(
	existing: ProviderNodeRow[],
	fields: { name: string; prefix: string },
	exceptId?: string,
): void {
	const refusal = findDuplicate(existing, { ...fields, exceptId })
	if (refusal) throw conflict(refusal.message)
}

/** `undefined` means the value was unusable; `null` means "none given". */
function requireLogo(normalize: (v: unknown) => string | null | undefined, raw: unknown) {
	const logo = normalize(raw)
	if (logo === undefined) throw invalid("Logo must be a small PNG, JPEG, WebP or GIF data URL")
	return logo
}

export function makeProviderNodes(deps: ProviderNodeDependencies) {
	const { nodes, connections } = deps

	return {
		async list(): Promise<ProviderNodeRow[]> {
			return nodes.list()
		},

		async create(body: Record<string, unknown>): Promise<ProviderNodeRow> {
			const type = body.type
			if (!isProviderNodeType(type)) throw invalid("Provider node type is required")

			const refusal = validateNodeFields({ name: body.name, prefix: body.prefix })
			if (refusal) throw invalid(refusal.message)

			const apiTypeRefusal = validateApiType(type, body.apiType)
			if (apiTypeRefusal) throw invalid(apiTypeRefusal.message)

			// An omitted logo is "none given" (null), not an unusable value; only a
			// supplied value that cannot be used is refused.
			const logo = body.logo === undefined ? null : requireLogo(deps.normalizeLogo, body.logo)
			const name = String(body.name).trim()
			const prefix = String(body.prefix).trim()

			refuseDuplicate(await nodes.list(), { name, prefix })

			const shared = {
				type,
				name,
				prefix,
				baseUrl: sanitizeBaseUrl(type, body.baseUrl),
				brand: body.brand,
				logo,
			}
			// Only the two gateway types bill quota; an embedding node has no credits.
			const quota =
				type === OPENAI_COMPATIBLE || type === "anthropic-compatible"
					? {
							quotaEnabled: body.quotaEnabled === true,
							quotaPath: sanitizeQuotaPath(body.quotaPath),
						}
					: {}

			return nodes.create({
				id: `${idPrefix(type, deps)}${deps.generateId()}`,
				...shared,
				...(type === OPENAI_COMPATIBLE ? { apiType: body.apiType } : {}),
				...quota,
			})
		},

		/**
		 * Full update, as `PUT /provider-nodes/[id]` and `PATCH /provider-nodes`
		 * both mean. Required fields are required here; a partial patch has its own
		 * shape and should not silently double as a full replace.
		 */
		async update(id: string, body: Record<string, unknown>): Promise<ProviderNodeRow> {
			const existing = await nodes.find(id)
			if (!existing) throw notFound("Provider node")

			const type = String(existing.type ?? "")
			const refusal = validateNodeFields({ name: body.name, prefix: body.prefix })
			if (refusal) throw invalid(refusal.message)

			const apiTypeRefusal = validateApiType(type, body.apiType)
			if (apiTypeRefusal) throw invalid(apiTypeRefusal.message)

			const name = String(body.name).trim()
			const prefix = String(body.prefix).trim()
			// An update must not recreate the duplicate `create` refuses. Excluding
			// its own id is what lets an operator keep a node's name unchanged.
			refuseDuplicate(await nodes.list(), { name, prefix }, id)

			// Three outcomes, not two: omitted leaves the stored logo alone, "" clears
			// it, and anything else must be usable. `null` alone cannot express both
			// "leave it" and "clear it", which is how a clear used to do nothing.
			const logo = body.logo === undefined ? undefined : requireLogo(deps.normalizeLogo, body.logo)

			const patch: Record<string, unknown> = {
				name,
				prefix,
				baseUrl: sanitizeBaseUrl(type, body.baseUrl ?? existing.baseUrl),
			}
			if (logo !== undefined) patch.logo = logo
			if (type === OPENAI_COMPATIBLE) patch.apiType = body.apiType

			if (type === OPENAI_COMPATIBLE || type === "anthropic-compatible") {
				// Preserved when absent: an older client that never sent the field would
				// otherwise switch quota reporting off on every save.
				patch.quotaEnabled =
					typeof body.quotaEnabled === "boolean" ? body.quotaEnabled : existing.quotaEnabled === true
				patch.quotaPath = sanitizeQuotaPath(
					typeof body.quotaPath === "string" && body.quotaPath.trim()
						? body.quotaPath
						: existing.quotaPath,
				)
			}

			const updated = await nodes.update(id, patch)
			if (!updated) throw notFound("Provider node")

			await this.syncConnections(id, updated)
			return updated
		},

		/**
		 * Copy the node's routing fields onto the connections that use it.
		 *
		 * Only the fields a connection actually needs are copied: `providerSpecificData`
		 * is merged rather than replaced, because it also holds credentials.
		 */
		async syncConnections(nodeId: string, node: ProviderNodeRow): Promise<void> {
			const owned = await connections.list({ provider: nodeId })
			await Promise.all(
				owned.map((connection) => {
					const specific = (connection.providerSpecificData ?? {}) as Record<string, unknown>
					return connections.update(connection.id, {
						providerSpecificData: {
							...specific,
							prefix: node.prefix,
							baseUrl: node.baseUrl,
							nodeName: node.name,
							...(node.type === OPENAI_COMPATIBLE ? { apiType: node.apiType } : {}),
							...(node.quotaEnabled === undefined
								? {}
								: { quotaEnabled: node.quotaEnabled, quotaPath: node.quotaPath }),
						},
					})
				}),
			)
		},

		/** A node's connections are its children: deleting one must take both. */
		async remove(id: string): Promise<void> {
			const existing = await nodes.find(id)
			if (!existing) throw notFound("Provider node")
			await nodes.removeConnections(id)
			await nodes.remove(id)
		},
	}
}

export type ProviderNodes = ReturnType<typeof makeProviderNodes>

/** The default base URL for a type, for the dashboard's "reset" button. */
export function defaultBaseUrl(type: string): string {
	return DEFAULT_BASE_URLS[type] ?? ""
}
