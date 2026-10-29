/**
 * Ask one connection's provider which models it offers.
 *
 * Called from:
 *   - `apps/api/src/application/use-cases.ts` (`makeListProviderModels`,
 *     registered as `listProviderModels`)
 *   - `apps/web/src/app/api/providers/[id]/models/route.ts` via
 *     `getUseCases().listProviderModels.run(id)`
 *   - `tests/unit/use-case-list-provider-models.test.ts`
 *
 * No existing file serves this purpose: `probe-models.ts` asks whether each model
 * *works*; this asks the provider what it has. `suggest-models.ts` answers from a
 * catalogue with a live probe as one of three layers; this live-probes only.
 *
 * Reads: the connection (`StoredConnection`: id, provider, apiKey, accessToken,
 * providerSpecificData.baseUrl) and the provider's addressing shape. Writes:
 * refreshed tokens (`accessToken`, `refreshToken`, `expiresIn`) via
 * `persistTokens`. Everything provider-specific — 15 providers, two shapes — is
 * behind the injected `resolveCustom`, so this file holds only the order of the
 * checks.
 *
 * User instruction, verbatim: "lanjut kenapa malah berhenti".
 */

import { invalid, notFound } from "../../domain/errors.ts"
import { anthropicModelsBaseUrl, modelsEndpoint } from "../../domain/model-list.ts"
import type { ProviderCatalogue, StoredConnection } from "./ports.ts"

/** What a request for a model list needs from the outside world. */
export interface ModelListDependencies {
	readonly connections: {
		find(id: string): Promise<StoredConnection | null>
	}
	readonly catalogue: ProviderCatalogue
	/**
	 * Fetch a model list over HTTP. `timeoutMs` bounds the whole request: without
	 * it a provider that accepts the connection and then says nothing holds this
	 * handler open until the platform kills it.
	 */
	readonly fetchModels: (request: ModelsRequest) => Promise<ModelsAnswer>
	/**
	 * Resolve a provider whose list does not come from a fixed URL — an OAuth
	 * provider that refreshes on 401, or one whose answer is not a `data` array.
	 * Answers `null` when this provider has no such resolver.
	 */
	readonly resolveCustom: (request: CustomModelsRequest) => Promise<CustomModelsResult | null>
}

/** How one request to a provider is addressed. */
export interface ModelsRequest {
	readonly url: string
	readonly method: "GET" | "POST"
	readonly headers: Record<string, string>
	readonly body?: string
	readonly apiKey: string | null
	readonly provider: string
	readonly timeoutMs: number
}

export interface ModelsAnswer {
	readonly ok: boolean
	readonly status: number
	readonly payload: unknown
}

export interface CustomModelsRequest {
	readonly connection: StoredConnection
	readonly timeoutMs: number
}

export type CustomModelsResult =
	| { readonly kind: "models"; readonly models: unknown[]; readonly warning?: string }
	| { readonly kind: "error"; readonly message: string; readonly status: number }

/** The dashboard's answer: whose list it is, and what was in it. */
export interface ModelListResult {
	readonly provider: string
	readonly connectionId: string
	readonly models: unknown[]
	readonly warning?: string
}

/**
 * How long a provider may take before the request is abandoned.
 *
 * Twenty seconds because the slowest of these providers (a cold OAuth refresh
 * followed by the list) is measured in seconds, and a dashboard request that
 * waits longer than this has already been given up on by the person watching it.
 */
export const MODELS_TIMEOUT_MS = 20_000

export function makeListProviderModels({
	connections,
	catalogue,
	fetchModels,
	resolveCustom,
}: ModelListDependencies) {
	return {
		/**
		 * Answer with the provider's own list.
		 *
		 * The order is the point: a connection that does not exist is a 404 before
		 * anything is fetched, and an unknown provider is a 400 that names it rather
		 * than a failed fetch.
		 */
		async run(connectionId: string): Promise<ModelListResult> {
			const connection = await connections.find(connectionId)
			if (!connection) throw notFound("Connection not found")

			const answer = await listFor(connection)
			return {
				provider: connection.provider,
				connectionId: connection.id,
				models: answer.models,
				...(answer.warning ? { warning: answer.warning } : {}),
			}
		},
	}

	/** Pick the addressing shape this provider uses and answer from it. */
	async function listFor(
		connection: StoredConnection,
	): Promise<{ models: unknown[]; warning?: string }> {
		const adapter = catalogue.modelListAdapter(connection.provider)

		if (adapter.kind === "openai-compatible" || adapter.kind === "anthropic-compatible") {
			return listFromCompatibleNode(connection, adapter.kind)
		}

		const custom = await resolveCustom({ connection, timeoutMs: MODELS_TIMEOUT_MS })
		if (custom?.kind === "error") {
			throw new ProviderRefusal(custom.message, custom.status)
		}
		if (custom) {
			return custom.warning
				? { models: custom.models, warning: custom.warning }
				: { models: custom.models }
		}

		if (adapter.kind !== "fixed-endpoint") {
			throw invalid(`Provider ${connection.provider} does not support models listing`)
		}

		return listFromFixedEndpoint(connection, adapter)
	}

	/**
	 * A compatible node states its own base URL, and the two compatible families
	 * address it differently: an OpenAI node takes `/models` straight, an
	 * Anthropic node may have been given the full message endpoint.
	 */
	async function listFromCompatibleNode(
		connection: StoredConnection,
		kind: "openai-compatible" | "anthropic-compatible",
	): Promise<{ models: unknown[] }> {
		const baseUrl = readNodeBaseUrl(connection)
		if (!baseUrl) {
			throw invalid(
				kind === "openai-compatible"
					? "No base URL configured for OpenAI compatible provider"
					: "No base URL configured for Anthropic compatible provider",
			)
		}

		const url =
			kind === "openai-compatible"
				? modelsEndpoint(baseUrl)
				: modelsEndpoint(anthropicModelsBaseUrl(baseUrl))

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Authorization: `Bearer ${connection.apiKey ?? ""}`,
		}
		if (kind === "anthropic-compatible") {
			headers["x-api-key"] = connection.apiKey ?? ""
			headers["anthropic-version"] = "2023-06-01"
		}

		const answer = await fetchModels({
			url,
			method: "GET",
			headers,
			apiKey: connection.apiKey ?? null,
			provider: connection.provider,
			timeoutMs: MODELS_TIMEOUT_MS,
		})
		if (!answer.ok) {
			throw new ProviderRefusal(`Failed to fetch models: ${answer.status}`, answer.status)
		}

		return { models: readList(answer.payload) }
	}

	/**
	 * A provider with a fixed endpoint: build the request from what the catalogue
	 * says about it, then read the list.
	 *
	 * The token goes in the query string for Gemini and in a header for the rest,
	 * because that is how each is documented — a mismatch here reads as an auth
	 * failure, not as a wrong URL.
	 */
	async function listFromFixedEndpoint(
		connection: StoredConnection,
		adapter: Extract<ReturnType<ProviderCatalogue["modelListAdapter"]>, { kind: "fixed-endpoint" }>,
	): Promise<{ models: unknown[] }> {
		const token = modelsTokenOf(connection)
		if (!token) throw new ProviderRefusal("No valid token found", 401)

		let url = adapter.url
		if (adapter.authQuery) url += `?${adapter.authQuery}=${token}`

		const headers: Record<string, string> = { ...adapter.headers }
		if (adapter.authHeader && !adapter.authQuery) {
			headers[adapter.authHeader] = (adapter.authPrefix ?? "") + token
		}

		const answer = await fetchModels({
			url,
			method: adapter.method,
			headers,
			...(adapter.body && adapter.method === "POST" ? { body: JSON.stringify(adapter.body) } : {}),
			apiKey: token,
			provider: connection.provider,
			timeoutMs: MODELS_TIMEOUT_MS,
		})
		if (!answer.ok) {
			throw new ProviderRefusal(`Failed to fetch models: ${answer.status}`, answer.status)
		}

		return { models: adapter.parse(answer.payload) }
	}
}

/** The token to present, preferring the shortest-lived credential available. */
function modelsTokenOf(connection: StoredConnection): string | null {
	const copilotToken = connection.providerSpecificData?.copilotToken
	if (typeof copilotToken === "string" && copilotToken) return copilotToken
	if (connection.accessToken) return connection.accessToken
	if (connection.apiKey) return connection.apiKey
	return null
}

/**
 * The base URL a compatible node was configured with, or null.
 *
 * The connection row wins over the node row: an operator who edited the
 * connection's base URL meant it, and falling back to the node would quietly
 * ignore the edit.
 */
function readNodeBaseUrl(connection: StoredConnection): string | null {
	const fromConnection = connection.providerSpecificData?.baseUrl
	if (typeof fromConnection === "string" && fromConnection) return fromConnection
	const fromRow = connection.baseUrl
	if (typeof fromRow === "string" && fromRow) return fromRow
	return null
}

/** Read the list out of an answer that may be OpenAI's shape or Gemini's. */
function readList(payload: unknown): unknown[] {
	if (!payload || typeof payload !== "object") return []
	const record = payload as Record<string, unknown>
	const list = Array.isArray(record.data) ? record.data : record.models
	return Array.isArray(list) ? list : []
}

/**
 * A provider answered, and the answer was a refusal we must pass on.
 *
 * Distinct from `invalid()` because the status is the provider's, not ours:
 * a 429 from the provider must reach the dashboard as a 429 so it can say "try
 * again later" instead of "your request was wrong".
 */
export class ProviderRefusal extends Error {
	readonly status: number
	constructor(message: string, status: number) {
		super(message)
		this.name = "ProviderRefusal"
		this.status = status
	}
}
