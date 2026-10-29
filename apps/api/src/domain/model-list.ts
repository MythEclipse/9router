/**
 * Rules for asking a provider which models it offers.
 *
 * A "list the models" request looks uniform from the outside and is not: the
 * answer is addressed differently per provider, and the shapes below are the
 * whole of that difference. Everything a provider shares with its neighbours
 * belongs here; everything only one provider does stays in its adapter.
 */

/** How a provider's model list is addressed. */
export type ModelsRequestShape =
	/** A fixed URL whose answer is read with a `data` or `models` array. */
	| { kind: "openai-list" }
	/** A fixed URL whose answer is read with a `data` array only. */
	| { kind: "anthropic-list" }
	/** Anything else: the caller has its own resolver. */
	| { kind: "custom" }

export function trimTrailingSlash(url: string): string {
	return url.replace(/\/+$/, "")
}

/** The URL to fetch, before any credential is attached. */
export function modelsEndpoint(baseUrl: string): string {
	return `${trimTrailingSlash(baseUrl)}/models`
}

/**
 * An Anthropic-compatible node is often configured with the full message
 * endpoint (`.../v1/messages`) instead of the version root. Stripping only
 * `/messages` keeps `/v1`; appending `/models` to the full endpoint instead
 * produces `.../v1/messages/models`, which never answers.
 */
export function anthropicModelsBaseUrl(baseUrl: string): string {
	const trimmed = trimTrailingSlash(baseUrl)
	return trimmed.endsWith("/messages") ? trimmed.slice(0, -"/messages".length) : trimmed
}

/**
 * Read the model array out of an answer that arrived as OpenAI's shape
 * (`{ data: [...] }`) or Gemini's (`{ models: [...] }`).
 *
 * An empty answer is an empty list, not an error: several providers answer 200
 * with nothing to say when the key has no access, and the dashboard shows that
 * as "no models" rather than as a failure worth alarming an operator about.
 */
export function readModelList(payload: unknown): unknown[] {
	if (!payload || typeof payload !== "object") return []
	const record = payload as Record<string, unknown>
	const list = Array.isArray(record.data) ? record.data : record.models
	return Array.isArray(list) ? list : []
}

/** The token to present, preferring the shortest-lived credential available. */
export function modelsTokenOf(connection: {
	providerSpecificData?: Record<string, unknown> | null
	accessToken?: string | null
	apiKey?: string | null
}): string | null {
	const copilotToken = connection.providerSpecificData?.copilotToken
	if (typeof copilotToken === "string" && copilotToken) return copilotToken
	if (connection.accessToken) return connection.accessToken
	if (connection.apiKey) return connection.apiKey
	return null
}

/**
 * Whether a failed answer should be retried once with a refreshed token.
 *
 * Only 401 and 403 are argued with, and only when a refresh token exists. Any
 * other status is the provider telling us something a new token will not change,
 * and retrying would spend a refresh for nothing.
 */
export function shouldRefreshOn(status: number, hasRefreshToken: boolean): boolean {
	return hasRefreshToken && (status === 401 || status === 403)
}

/**
 * A resolver's answer. An empty list is not a failure — it means "I have nothing
 * to add", and the caller falls back to its static catalogue. A resolver that
 * threw, or answered with an error status, carries a warning so the fallback is
 * visible rather than silent.
 */
export type ResolverAnswer =
	| { kind: "models"; models: unknown[]; warning?: string }
	| { kind: "error"; message: string; status: number }

export function resolverModels(models: unknown[], warning?: string): ResolverAnswer {
	return warning ? { kind: "models", models, warning } : { kind: "models", models }
}

/** Note for the fallback path, so the dashboard can say why it fell back. */
export function resolverWarning(label: string, detail: string): string {
	return `${label}: ${detail}`
}
