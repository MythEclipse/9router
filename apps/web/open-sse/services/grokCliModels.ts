import {
	GROK_CLI_BASE_URL,
	GROK_CLI_CLIENT_IDENTIFIER,
	GROK_CLI_MODEL,
	GROK_CLI_USER_AGENT,
	GROK_CLI_VERSION,
} from "../config/grokCli.ts"
import type { Credentials, EngineLogger, ProxyOptions, RefreshedCredentials } from "../types.ts"
import { proxyAwareFetch } from "../utils/proxyFetch.ts"
import { refreshProviderCredentials } from "./oauthCredentialManager.ts"

const MODELS_URL = `${GROK_CLI_BASE_URL}/models`

/** One selectable Grok CLI model (raw upstream fields are preserved). */
export interface GrokCliModel {
	id: string
	name: unknown
	contextLength?: number
	maxOutputTokens?: number
	[key: string]: unknown
}

/** Result of a catalog probe: models, or a human-readable warning. */
export interface GrokCliModelsResult {
	models: GrokCliModel[]
	warning?: string
}

/** Fetch surface; defaults to the proxy-aware global fetch. */
export type GrokCliFetchFn = (
	url: string,
	init: RequestInit,
	proxyOptions: ProxyOptions | null,
) => Promise<Response>

export interface ResolveGrokCliModelsOptions {
	fetchFn?: GrokCliFetchFn
	log?: EngineLogger
	proxyOptions?: ProxyOptions | null
	onCredentialsRefreshed?: (refreshed: RefreshedCredentials) => void | Promise<void>
}

function modelEntries(data: unknown): Array<[string | null, unknown]> {
	const envelope = data as { data?: unknown; models?: unknown; results?: unknown } | null
	const value = Array.isArray(data)
		? data
		: (envelope?.data ?? envelope?.models ?? envelope?.results ?? [])
	if (Array.isArray(value)) return value.map((item) => [null, item])
	if (value && typeof value === "object") return Object.entries(value)
	return []
}

export function parseGrokCliModels(data: unknown): GrokCliModel[] {
	const seen = new Set<string>()
	const models: GrokCliModel[] = []

	for (const [key, raw] of modelEntries(data)) {
		const item = typeof raw === "string" ? { id: raw } : (raw as Record<string, unknown> | null)
		if (!item || typeof item !== "object" || Array.isArray(item)) continue
		const id = String(
			item.id ?? item.model_id ?? item.modelId ?? item.model ?? item.slug ?? key ?? item.name ?? "",
		).trim()
		if (!id || seen.has(id)) continue
		seen.add(id)

		const model: GrokCliModel = {
			...item,
			id,
			name: item.display_name ?? item.displayName ?? item.name ?? id,
		}
		const contextLength = Number(
			item.context_length ?? item.contextLength ?? item.context_window ?? item.contextWindow,
		)
		const maxOutputTokens = Number(item.max_output_tokens ?? item.maxOutputTokens)
		if (Number.isFinite(contextLength) && contextLength > 0) model.contextLength = contextLength
		if (Number.isFinite(maxOutputTokens) && maxOutputTokens > 0) {
			model.maxOutputTokens = maxOutputTokens
		}
		if (id === GROK_CLI_MODEL) {
			model.contextLength ||= 500000
			model.maxOutputTokens ||= 64000
		}
		models.push(model)
	}

	return models
}

function buildHeaders(accessToken: string, providerSpecificData: Record<string, unknown> = {}) {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${accessToken}`,
		Accept: "application/json",
		"User-Agent": GROK_CLI_USER_AGENT,
		"x-xai-token-auth": "xai-grok-cli",
		"x-grok-client-version": GROK_CLI_VERSION,
		"x-grok-client-identifier": GROK_CLI_CLIENT_IDENTIFIER,
		"x-grok-client-mode": "headless",
	}
	const email = providerSpecificData?.email as string | undefined
	const userId = (providerSpecificData?.userId || providerSpecificData?.principalId) as
		| string
		| undefined
	if (email) headers["x-email"] = email
	if (userId) headers["x-userid"] = userId
	return headers
}

export async function resolveGrokCliModels(
	credentials: Credentials,
	options: ResolveGrokCliModelsOptions = {},
): Promise<GrokCliModelsResult> {
	const {
		fetchFn = proxyAwareFetch,
		log = console,
		proxyOptions = null,
		onCredentialsRefreshed,
	} = options
	let accessToken = credentials?.accessToken
	if (!accessToken) return { models: [], warning: "Grok CLI access token is missing." }

	const request = (token: string) =>
		fetchFn(
			MODELS_URL,
			{
				method: "GET",
				headers: buildHeaders(
					token,
					credentials?.providerSpecificData as Record<string, unknown> | undefined,
				),
			},
			proxyOptions ?? null,
		)

	try {
		let response = await request(accessToken)
		if ((response.status === 401 || response.status === 403) && credentials?.refreshToken) {
			const refreshed = await refreshProviderCredentials("grok-cli", credentials, log, proxyOptions)
			if (refreshed?.accessToken) {
				accessToken = refreshed.accessToken
				try {
					await onCredentialsRefreshed?.(refreshed)
				} catch (error) {
					log?.warn?.("Grok CLI credential persistence failed", error)
				}
				response = await request(accessToken)
			}
		}

		if (!response.ok) {
			const detail = await response.text().catch(() => "")
			return {
				models: [],
				warning: `Grok CLI model discovery failed (${response.status})${detail ? `: ${detail.slice(0, 160)}` : ""}`,
			}
		}

		const models = parseGrokCliModels(await response.json())
		return models.length
			? { models }
			: { models: [], warning: "Grok CLI returned no selectable models." }
	} catch (error) {
		return { models: [], warning: `Grok CLI model discovery failed: ${(error as Error).message}` }
	}
}
