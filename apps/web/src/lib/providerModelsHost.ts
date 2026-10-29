import type {
	CustomModelsRequest,
	CustomModelsResult,
	ModelsAnswer,
	ModelsRequest,
} from "9router-api/application/providers/list-provider-models"
import type { ModelListAdapter } from "9router-api/application/providers/ports"
import { getModelsByProviderId } from "open-sse/config/providerModels"
import { resolveOllamaLocalHost } from "open-sse/config/providers"
import codexProvider from "open-sse/providers/registry/codex"
import { resolveClineModels, resolveClinepassModels } from "open-sse/services/clinepassModels"
import { resolveCursorModels } from "open-sse/services/cursorModels"
import { resolveGrokCliModels } from "open-sse/services/grokCliModels"
import { resolveKimchiModels } from "open-sse/services/kimchiModels"
import { resolveKiroModels } from "open-sse/services/kiroModels"
import { NOUS_MODELS_URL, normalizeNousModels } from "open-sse/services/nous"
import { resolveQoderModels } from "open-sse/services/qoderModels"
import { resolveZedModels } from "open-sse/shared/zedAuth"
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy"
import { GEMINI_CONFIG, ZED_HOSTED_CONFIG } from "@/lib/oauth/constants/oauth"
import {
	isAnthropicCompatibleProvider,
	isOpenAICompatibleProvider,
} from "@/shared/constants/providers"
import {
	refreshCodexToken,
	refreshGoogleToken,
	updateProviderCredentials,
} from "@/sse/services/tokenRefresh"

const GEMINI_CLI_MODELS_URL = "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels"
const CODEX_MODELS_URL = `https://chatgpt.com/backend-api/codex/models?client_version=${codexProvider.transport.cliVersion}`

type FixedEndpoint = Omit<Extract<ModelListAdapter, { kind: "fixed-endpoint" }>, "kind">

/**
 * Providers whose model list comes from one fixed URL, with the per-provider
 * parser that reads it.
 *
 * Nothing here is uniform, so nothing is inferred: the platforms disagree on the
 * auth address (header vs query), on the response key (`data` vs `models`), and
 * on what a model entry means — GitHub wants only `capabilities.type === "chat"`
 * with a non-disabled policy, Codex wants review variants appended, Nous wants
 * its vendor namespace prefixed so Basic Chat does not read it as a provider.
 */
const FIXED_ENDPOINTS: Record<
	string,
	Omit<Extract<ModelListAdapter, { kind: "fixed-endpoint" }>, "kind"> & {
		readonly parse: (data: unknown) => unknown[]
	}
> = {
	muse: {
		url: "https://api.meta.ai/v1/models",
		method: "GET",
		headers: { "Content-Type": "application/json", "x-api-version": "1.0.0" },
		authHeader: "Authorization",
		authPrefix: "Bearer ",
		parse: (data) => (data as { data?: unknown[] })?.data || [],
	},
	claude: {
		url: "https://api.anthropic.com/v1/models",
		method: "GET",
		headers: { "Anthropic-Version": "2023-06-01", "Content-Type": "application/json" },
		authHeader: "x-api-key",
		parse: (data) => (data as { data?: unknown[] })?.data || [],
	},
	gemini: {
		url: "https://generativelanguage.googleapis.com/v1beta/models",
		method: "GET",
		headers: { "Content-Type": "application/json" },
		authQuery: "key",
		parse: (data) => (data as { models?: unknown[] })?.models || [],
	},
	openai: openAIModels("https://api.openai.com/v1/models"),
	openrouter: openAIModels("https://openrouter.ai/api/v1/models"),
	nous: { ...openAIModels(NOUS_MODELS_URL), parse: normalizeRoutedNousModels },
	anthropic: {
		url: "https://api.anthropic.com/v1/models",
		method: "GET",
		headers: { "Anthropic-Version": "2023-06-01", "Content-Type": "application/json" },
		authHeader: "x-api-key",
		parse: (data) => (data as { data?: unknown[] })?.data || [],
	},
	alicode: bearerModels("https://coding.dashscope.aliyuncs.com/v1/models"),
	"alicode-intl": bearerModels("https://coding-intl.dashscope.aliyuncs.com/v1/models"),
	"alims-intl": bearerModels("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models"),
	"volcengine-ark": openAIModels("https://ark.cn-beijing.volces.com/api/coding/v3/models"),
	byteplus: openAIModels("https://ark.ap-southeast.bytepluses.com/api/coding/v3/models"),
	deepseek: openAIModels("https://api.deepseek.com/models"),
	groq: openAIModels("https://api.groq.com/openai/v1/models"),
	xai: openAIModels("https://api.x.ai/v1/models"),
	mistral: openAIModels("https://api.mistral.ai/v1/models"),
	perplexity: openAIModels("https://api.perplexity.ai/v1/models"),
	"perplexity-agent": openAIModels("https://api.perplexity.ai/v1/models"),
	together: openAIModels("https://api.together.xyz/v1/models"),
	fireworks: openAIModels("https://api.fireworks.ai/inference/v1/models"),
	cerebras: openAIModels("https://api.cerebras.ai/v1/models"),
	cohere: openAIModels("https://api.cohere.ai/v1/models"),
	nebius: openAIModels("https://api.studio.nebius.ai/v1/models"),
	siliconflow: openAIModels("https://api.siliconflow.com/v1/models"),
	hyperbolic: openAIModels("https://api.hyperbolic.xyz/v1/models"),
	// Ollama's cloud catalog lives under /api/tags, not /models.
	ollama: openAIModels("https://ollama.com/api/tags"),
	nanobanana: openAIModels("https://api.nanobananaapi.ai/v1/models"),
	chutes: openAIModels("https://llm.chutes.ai/v1/models"),
	nvidia: openAIModels("https://integrate.api.nvidia.com/v1/models"),
	assemblyai: openAIModels("https://api.assemblyai.com/v1/models"),
	"vercel-ai-gateway": openAIModels("https://ai-gateway.vercel.sh/v1/models"),
	dothoosh: openAIModels("https://gateway.dothoosh.com/v1/models"),
	tokenharbor: openAIModels("https://tokenharbor.ai/v1/models"),
	dahl: openAIModels("https://inference.dahl.global/v1/models"),
	atria: openAIModels("https://api.atria-asi.ai/v1/models"),
	agnes: openAIModels("https://apihub.agnes-ai.com/v1/models"),
	bai: openAIModels("https://api.b.ai/v1/models"),
}

/** An OpenAI-shaped catalogue behind a bearer token. */
function openAIModels(url: string) {
	return {
		url,
		method: "GET" as const,
		headers: { "Content-Type": "application/json" },
		authHeader: "Authorization",
		authPrefix: "Bearer ",
		parse: (data: unknown) => parseOpenAIStyleModels(data),
	}
}

/** A catalogue that wants the token in a plain `Authorization: Bearer` header. */
function bearerModels(url: string) {
	return {
		url,
		method: "GET" as const,
		headers: { "Content-Type": "application/json" },
		authHeader: "Authorization",
		authPrefix: "Bearer ",
		parse: (data: unknown) => (data as { data?: unknown[] })?.data || [],
	}
}

/** A catalogue that lists models under `data`, `models` or `results`. */
function parseOpenAIStyleModels(data: unknown): unknown[] {
	if (Array.isArray(data)) return data
	const record = data as { data?: unknown[]; models?: unknown[]; results?: unknown[] } | null
	return record?.data || record?.models || record?.results || []
}

/** Providers that answer through a resolver of their own. */
const CUSTOM_RESOLVERS: readonly string[] = [
	"codex",
	"gemini-cli",
	"github",
	"nous",
	"anthropic",
	"antigravity",
	"alicode",
	"alicode-intl",
	"alims-intl",
	"kimchi",
	"cursor",
	"zed",
	"cline",
	"clinepass",
	"kiro",
	"grok-cli",
	"qoder",
	"qoder-cn",
	"ollama-local",
]

/**
 * How a provider answers "which models do you have".
 *
 * A compatible node is decided by the id's shape, a fixed endpoint by the table,
 * a resolver by the list. Anything else — a provider that only forwards requests
 * and has no catalogue — answers `unsupported`, which the route reports as a 400
 * naming the provider rather than as a failed fetch.
 */
export function modelListAdapter(provider: string): ModelListAdapter {
	if (isOpenAICompatibleProvider(provider)) return { kind: "openai-compatible" }
	if (isAnthropicCompatibleProvider(provider)) return { kind: "anthropic-compatible" }
	const fixed = FIXED_ENDPOINTS[provider]
	if (fixed) return { kind: "fixed-endpoint", ...fixed }
	if (CUSTOM_RESOLVERS.includes(provider)) return { kind: "custom" }
	return { kind: "unsupported" }
}

/**
 * One model-list request, bounded.
 *
 * `AbortSignal.timeout` rather than a race against a timer: a race leaves the
 * connection open, so the operator's second click competes with the first
 * abandoned request.
 */
export async function fetchModels(request: ModelsRequest): Promise<ModelsAnswer> {
	const response = await fetch(request.url, {
		method: request.method,
		headers: request.headers,
		...(request.body ? { body: request.body } : {}),
		signal: AbortSignal.timeout(request.timeoutMs),
	})
	const text = await response.text()
	let payload: unknown = null
	try {
		payload = text ? JSON.parse(text) : null
	} catch {
		payload = null
	}
	if (!response.ok) console.log(`Error fetching models from ${request.provider}:`, text)
	return { ok: response.ok, status: response.status, payload }
}

/**
 * Run the resolver belonging to this provider.
 *
 * Returns null for a provider with no resolver, which tells the caller the fixed
 * endpoints and compatible nodes were the only possibilities left.
 */
export async function resolveCustomModels(
	request: CustomModelsRequest,
): Promise<CustomModelsResult | null> {
	const { timeoutMs } = request
	// The store's rows are read-only; a refresh needs to hand the new token to the
	// retry, so work on a copy and let the write-back own persistence.
	const connection: Record<string, unknown> = { ...request.connection }
	const provider = connection.provider

	switch (provider) {
		case "codex":
			return oauthResolver({
				refreshFn: (conn) => refreshCodexToken(conn.refreshToken as string),
				fetchFn: (token) =>
					fetch(CODEX_MODELS_URL, {
						method: "GET",
						headers: {
							"Content-Type": "application/json",
							Accept: "application/json",
							Authorization: `Bearer ${token}`,
							originator: "codex_cli_rs",
						},
						signal: AbortSignal.timeout(timeoutMs),
					}),
				parseFn: parseCodexModels,
				errorLabel: "Failed to fetch Codex models",
			})(connection)

		case "gemini-cli":
			return oauthResolver({
				refreshFn: (conn) =>
					refreshGoogleToken(
						conn.refreshToken as string,
						GEMINI_CONFIG.clientId,
						GEMINI_CONFIG.clientSecret,
					),
				fetchFn: (token, conn) => {
					const projectId =
						conn.projectId || (conn.providerSpecificData as { projectId?: string })?.projectId
					return fetch(GEMINI_CLI_MODELS_URL, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${token}`,
							"User-Agent": "google-api-nodejs-client/9.15.1",
							"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
						},
						body: JSON.stringify(projectId ? { project: projectId } : {}),
						signal: AbortSignal.timeout(timeoutMs),
					})
				},
				parseFn: parseGeminiCliModels,
				errorLabel: "Failed to fetch Gemini CLI models",
			})(connection)

		case "github":
			return directResolver({
				provider,
				label: "GitHub Copilot",
				resolve: async () => {
					const response = await fetch("https://api.githubcopilot.com/models", {
						method: "GET",
						headers: {
							"Content-Type": "application/json",
							"Copilot-Integration-Id": "vscode-chat",
							"editor-version": "vscode/1.107.1",
							"editor-plugin-version": "copilot-chat/0.26.7",
							"user-agent": "GitHubCopilotChat/0.26.7",
							Authorization: `Bearer ${connection.accessToken}`,
						},
						signal: AbortSignal.timeout(timeoutMs),
					})
					if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
					return parseGithubModels(await response.json())
				},
			})

		case "nous":
			return directResolver({
				provider,
				label: "Nous",
				resolve: async () => {
					const response = await fetch(NOUS_MODELS_URL, {
						method: "GET",
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${connection.accessToken}`,
						},
						signal: AbortSignal.timeout(timeoutMs),
					})
					if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
					return normalizeRoutedNousModels(await response.json())
				},
			})

		case "anthropic":
			return directResolver({
				provider,
				label: "Claude",
				resolve: async () => {
					const response = await fetch("https://api.anthropic.com/v1/models", {
						method: "GET",
						headers: {
							"Anthropic-Version": "2023-06-01",
							"Content-Type": "application/json",
							"x-api-key": String(connection.apiKey ?? ""),
						},
						signal: AbortSignal.timeout(timeoutMs),
					})
					if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
					return ((await response.json()) as { data?: unknown[] }).data || []
				},
			})

		case "antigravity":
			return directResolver({
				provider,
				label: "Antigravity",
				resolve: async () => {
					const response = await fetch(
						"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:models",
						{
							method: "POST",
							headers: {
								"Content-Type": "application/json",
								Authorization: `Bearer ${connection.accessToken}`,
							},
							body: JSON.stringify({}),
							signal: AbortSignal.timeout(timeoutMs),
						},
					)
					if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
					return ((await response.json()) as { models?: unknown[] }).models || []
				},
			})

		case "alicode":
		case "alicode-intl":
		case "alims-intl":
			return directResolver({
				provider,
				label: provider,
				resolve: async () => {
					const endpoint = FIXED_ENDPOINTS[provider]
					const response = await fetch(endpoint.url, {
						method: "GET",
						headers: {
							...endpoint.headers,
							Authorization: `Bearer ${connection.apiKey}`,
						},
						signal: AbortSignal.timeout(timeoutMs),
					})
					if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
					return endpoint.parse(await response.json())
				},
			})

		case "ollama-local":
			return directResolver({
				provider,
				label: "Ollama local",
				resolve: async () => {
					const response = await fetch(`${resolveOllamaLocalHost(connection)}/api/tags`, {
						method: "GET",
						headers: { "Content-Type": "application/json" },
						signal: AbortSignal.timeout(timeoutMs),
					})
					if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
					return parseOpenAIStyleModels(await response.json())
				},
			})

		case "kimchi":
			return moduleResolver(
				provider,
				async () => {
					const result = await resolveKimchiModels(
						{
							accessToken: connection.accessToken as string,
							apiKey: connection.apiKey as string,
							providerSpecificData: specificData(connection),
						},
						{ forceRefresh: true, log: console },
					)
					return result?.models?.length ? result.models : []
				},
				"Kimchi",
			)

		case "cursor":
			return moduleResolver(
				provider,
				async () => {
					const result = await resolveCursorModels(
						{
							accessToken: connection.accessToken as string,
							providerSpecificData: specificData(connection),
						},
						{ forceRefresh: true, log: console },
					)
					return result?.models?.length ? result.models : []
				},
				"Cursor",
			)

		case "cline":
			return moduleResolver(
				provider,
				async () => {
					const result = await resolveClineModels({
						accessToken: connection.accessToken as string,
						apiKey: connection.apiKey as string,
					})
					return result?.models?.length ? result.models : []
				},
				"Cline",
			)

		case "clinepass":
			return moduleResolver(
				provider,
				async () => {
					const result = await resolveClinepassModels({
						accessToken: connection.accessToken as string,
						apiKey: connection.apiKey as string,
					})
					return result?.models?.length ? result.models : []
				},
				"ClinePass",
			)

		// Zed has no static catalog by design (live /models only): resolve with the
		// connection's own credentials, return rich metadata, drop disabled entries.
		// Empty or failed yields an explicit warning, never a silent zero list.
		case "zed":
			return directResolver({
				provider,
				label: "Zed",
				resolve: async () => {
					const result = await resolveZedModels(
						{
							accessToken: connection.accessToken as string,
							providerSpecificData: specificData(connection),
						},
						{ config: ZED_HOSTED_CONFIG, forceRefresh: true },
					)
					return (result?.models || [])
						.filter((m) => m && !m.isDisabled)
						.map((m) => ({
							id: m.id,
							name: m.name || m.id,
							provider: m.provider,
							contextLength: m.contextLength,
							contextLengthInMaxMode: m.contextLengthInMaxMode,
							maxOutputTokens: m.maxOutputTokens,
							supportsTools: m.supportsTools,
							supportsImages: m.supportsImages,
							supportsThinking: m.supportsThinking,
							supportsDisablingThinking: m.supportsDisablingThinking,
							supportsFastMode: m.supportsFastMode,
							supportsServerSideCompaction: m.supportsServerSideCompaction,
							supportedEffortLevels: m.supportedEffortLevels || [],
							supportsStreamingTools: m.supportsStreamingTools,
							supportsParallelToolCalls: m.supportsParallelToolCalls,
						}))
				},
			})

		case "kiro":
			return directResolver({
				provider,
				label: "Kiro",
				resolve: async () => {
					const result = await resolveKiroModels(
						{
							accessToken: connection.accessToken as string,
							refreshToken: connection.refreshToken as string,
							providerSpecificData: specificData(connection),
						},
						{
							log: console,
							onCredentialsRefreshed: async (refreshed) => {
								if (!refreshed?.accessToken) return
								await updateProviderCredentials(connection.id as string, {
									accessToken: refreshed.accessToken,
									refreshToken: refreshed.refreshToken || connection.refreshToken,
									expiresIn: refreshed.expiresIn,
								})
								connection.accessToken = refreshed.accessToken
								if (refreshed.refreshToken) connection.refreshToken = refreshed.refreshToken
							},
						},
					)
					return (result?.models || []).map((m) => ({
						id: m.id,
						name: m.name,
						upstreamModelId: m.upstreamModelId,
						contextLength: m.contextLength,
						rateMultiplier: m.rateMultiplier,
						capabilities: m.capabilities,
						description: m.description,
					}))
				},
			})

		case "grok-cli":
			return directResolver({
				provider,
				label: "Grok CLI",
				resolve: async () => {
					const proxy = await resolveConnectionProxyConfig(specificData(connection))
					const result = await resolveGrokCliModels(
						{ ...specificData(connection), ...connection, connectionId: connection.id } as never,
						{
							log: console,
							proxyOptions: {
								connectionProxyEnabled: proxy.connectionProxyEnabled === true,
								connectionProxyUrl: proxy.connectionProxyUrl || "",
								connectionNoProxy: proxy.connectionNoProxy || "",
								vercelRelayUrl: proxy.vercelRelayUrl || "",
								strictProxy: proxy.strictProxy === true,
							},
							onCredentialsRefreshed: async (refreshed) => {
								await updateProviderCredentials(connection.id as string, {
									...refreshed,
									existingProviderSpecificData: connection.providerSpecificData || {},
								})
							},
						},
					)
					return result.models
				},
			})

		case "qoder":
		case "qoder-cn":
			return qoderResolver(provider)(connection)

		default:
			return null
	}
}

/**
 * A provider module whose refusals are worth a warning rather than a failure.
 *
 * The dashboard shows the static catalogue with a note saying why it fell back,
 * which is better than an empty list that looks like "this provider has no
 * models".
 */
async function directResolver({
	provider,
	label,
	resolve,
}: {
	provider: string
	label: string
	resolve: () => Promise<unknown[]>
}): Promise<CustomModelsResult> {
	try {
		const models = await resolve()
		if (models.length > 0) return { kind: "models", models }
		return {
			kind: "models",
			models: readStaticModels(provider),
			warning: `${label} returned no live models; falling back to static catalog.`,
		}
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error)
		console.log(`Failed to fetch ${label} models dynamically, falling back to static:`, detail)
		return {
			kind: "models",
			models: readStaticModels(provider),
			warning: `Failed to fetch ${label} models: ${detail}`,
		}
	}
}

/** Run one provider module's resolver, where an empty answer is a warning too. */
async function moduleResolver(
	provider: string,
	resolve: () => Promise<unknown[]>,
	label: string,
): Promise<CustomModelsResult> {
	return directResolver({ provider, label, resolve })
}

/** GitHub Copilot answers every model, including ones the plan cannot use. */
function parseGithubModels(data: unknown): unknown[] {
	const list = (data as { data?: Record<string, unknown>[] })?.data
	if (!Array.isArray(list)) return []
	return list
		.filter((m) => (m.capabilities as { type?: string })?.type === "chat")
		.filter((m) => (m.policy as { state?: string })?.state !== "disabled")
		.map((m) => ({
			id: m.id,
			name: m.name || m.id,
			version: m.version,
			capabilities: m.capabilities,
			isDefault: m.model_picker_enabled === true,
		}))
}

/**
 * Gemini CLI answers `{ models: [...] }` or `{ models: { id: entry } }`, and it
 * marks its own internal models, which must not appear in the picker.
 */
function parseGeminiCliModels(data: unknown): unknown[] {
	const models = (data as { models?: unknown })?.models
	if (Array.isArray(models)) {
		return models
			.map((item) => {
				const entry = item as Record<string, string>
				const id = entry?.id || entry?.model || entry?.name
				return id ? { id, name: entry?.displayName || entry?.name || id } : null
			})
			.filter((item): item is { id: string; name: string } => item !== null)
	}
	if (models && typeof models === "object") {
		return Object.entries(
			models as Record<string, { displayName?: string; name?: string; isInternal?: boolean }>,
		)
			.filter(([, info]) => !info?.isInternal)
			.map(([id, info]) => ({ id, name: info?.displayName || info?.name || id }))
	}
	return []
}

/** Codex lists chat models only, and each one also gets a review variant. */
function parseCodexModels(data: unknown): unknown[] {
	return parseOpenAIStyleModels(data).flatMap((raw) => {
		const model = raw as Record<string, string>
		const id = model?.id || model?.slug || model?.model || model?.name
		if (!id) return []
		const name = model?.display_name || model?.displayName || model?.name || id
		const normalized = { ...model, id, name }
		const isChatModel = (model?.type || "llm") !== "image" && !id.toLowerCase().includes("embed")
		if (!isChatModel || id.endsWith("-review")) return [normalized]
		return [
			normalized,
			{
				...normalized,
				id: `${id}-review`,
				name: `${name} Review`,
				upstreamModelId: id,
				quotaFamily: "review",
			},
		]
	})
}

/**
 * Live upstream IDs carry a vendor namespace (`stepfun/step-5-preview:free`).
 * Prefixing the owning provider stops Basic Chat reading that namespace as the
 * provider itself.
 */
function normalizeRoutedNousModels(data: unknown): unknown[] {
	return normalizeNousModels(data).map((model) => ({
		...model,
		id: `nous/${model.id}`,
		upstreamModelId: model.id,
	}))
}

/** The connection's own extra fields, or an empty bag the provider modules accept. */
function specificData(connection: Record<string, unknown>): Record<string, unknown> {
	const value = connection.providerSpecificData
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

/** The static catalogue, which is what most fallbacks answer with. */
function readStaticModels(provider: string): unknown[] {
	const models = getModelsByProviderId(provider)
	return Array.isArray(models)
		? models.map((model) => ({ ...model, id: model.id, name: model.name || model.id }))
		: []
}

/**
 * Build a resolver that retries once with a refreshed token.
 *
 * Only 401 and 403 are argued with, and only when a refresh token exists and the
 * provider has a refresh function: any other status is the provider saying
 * something a new token will not change. The refreshed token is written back
 * before the retry, so a later failure does not leave the old one stored and
 * refresh on every request.
 */
function oauthResolver({
	refreshFn,
	fetchFn,
	parseFn,
	errorLabel,
}: {
	refreshFn: ((conn: Record<string, unknown>) => Promise<unknown>) | null
	fetchFn: (token: string, conn: Record<string, unknown>) => Promise<Response>
	parseFn: (data: unknown) => unknown[]
	errorLabel: string
}) {
	return async (connection: Record<string, unknown>): Promise<CustomModelsResult> => {
		const accessToken = connection.accessToken as string | undefined
		const refreshToken = connection.refreshToken as string | undefined
		if (!accessToken) return { kind: "error", message: "No valid token found", status: 401 }

		let warning: string | undefined
		try {
			let response = await fetchFn(accessToken, connection)
			const canRetry =
				refreshFn && refreshToken && (response.status === 401 || response.status === 403)
			if (canRetry) {
				const refreshed = (await refreshFn(connection)) as Record<string, unknown> | null
				if (refreshed?.accessToken) {
					await updateProviderCredentials(connection.id as string, {
						accessToken: refreshed.accessToken as string,
						refreshToken: (refreshed.refreshToken as string) || refreshToken,
						expiresIn: refreshed.expiresIn as number,
					})
					connection.accessToken = refreshed.accessToken
					if (refreshed.refreshToken) connection.refreshToken = refreshed.refreshToken
					response = await fetchFn(refreshed.accessToken as string, connection)
				}
			}

			if (response.ok) {
				const models = parseFn(await response.json())
				if (models.length > 0) return { kind: "models", models }
			} else {
				const errorText = await response.text()
				warning = `${errorLabel}: ${response.status} ${errorText}`
				console.log(`${errorLabel} (falling back to static):`, errorText)
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error)
			warning = `${errorLabel}: ${detail}`
			console.log(`${errorLabel} (falling back to static):`, detail)
		}

		return { kind: "models", models: [], warning }
	}
}

/**
 * Qoder shares one resolver across intl (`qoder`) and CN (`qoder-cn`); the
 * credentials carry the connection's provider so the module picks the right
 * region's catalogue endpoint, and the ids keep the provider prefix so the
 * dashboard surfaces the identifier the chat router expects.
 */
function qoderResolver(providerId: string) {
	return async (connection: Record<string, unknown>): Promise<CustomModelsResult> => {
		const credentials = {
			provider: providerId,
			accessToken: connection.accessToken,
			apiKey: connection.apiKey,
			refreshToken: connection.refreshToken,
			email: connection.email,
			displayName: connection.displayName,
			providerSpecificData: specificData(connection),
		}
		try {
			const result = await resolveQoderModels(credentials as never, { forceRefresh: true })
			if (result?.models?.length) {
				return {
					kind: "models",
					models: result.models.map((m) => ({
						id: `${providerId}/${m.id}`,
						name: m.name,
						contextLength: m.contextLength,
						isVL: m.isVL,
						isReasoning: m.isReasoning,
						maxOutputTokens: m.maxOutputTokens,
						description: m.description,
					})),
				}
			}
			return {
				kind: "models",
				models: readStaticModels(providerId),
				warning: "Qoder returned no models; falling back to static catalog.",
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error)
			console.log("Failed to fetch Qoder models dynamically, falling back to static:", detail)
			return {
				kind: "models",
				models: readStaticModels(providerId),
				warning: `Failed to fetch Qoder models: ${detail}`,
			}
		}
	}
}
