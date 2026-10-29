/**
 * The base-URL probe behind `POST /api/provider-nodes/validate`.
 *
 * Extracted from the route so the use-case can call it: the route now only reads
 * the request, asks the use-case, and maps the answer to a status. The three
 * type-specific paths (embeddings, anthropic, openai) are the same shape — fetch
 * with a timeout, treat an auth failure as final, fall back to a chat call — so
 * they differ only in the URL and headers they build.
 *
 * The timeout is an abort signal rather than `Promise.race`, so the socket is
 * actually torn down; a race leaves the losing fetch running.
 */
const TIMEOUT_MS = 10_000

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
	try {
		return await fetch(url, { ...init, signal: controller.signal })
	} finally {
		clearTimeout(timer)
	}
}

/** The caller-friendly reason a fetch failed, since `error.message` is unreadable. */
export function describeFetchError(error: unknown): string {
	const cause = (error as { cause?: { code?: string } })?.cause
	if (cause?.code === "ECONNREFUSED")
		return "Connection refused - provider node offline or unreachable"
	if (cause?.code === "ENOTFOUND") return "DNS lookup failed - invalid domain or network issue"
	if (cause?.code === "ETIMEDOUT") return "Connection timeout - provider node too slow"
	if (cause?.code === "CERT_HAS_EXPIRED") return "SSL certificate expired"
	if (cause?.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") return "SSL certificate verification failed"
	if (cause?.code) return `Network error: ${cause.code}`
	if (error instanceof Error && error.name === "AbortError") {
		return `Request timeout (>${TIMEOUT_MS / 1000}s) - provider node not responding`
	}
	return "Network connection failed - check URL and network connectivity"
}

function describeModelsError(status: number): string {
	if (status === 401 || status === 403) return "API key unauthorized"
	if (status === 404) return "/models endpoint not found - try chat validation with model ID"
	if (status >= 500) return "Server error - try again later"
	return `Unexpected response (${status})`
}

function describeChatError(status: number): string {
	if (status === 401 || status === 403) return "API key unauthorized"
	if (status === 400) return "Invalid model or bad request"
	if (status === 404) return "Chat endpoint not found"
	if (status >= 500) return "Server error - try again later"
	return `Chat request failed (${status})`
}

/** Pings `/chat/completions`, the fallback when `/models` is refused. */
async function chatProbe(
	base: string,
	headers: Record<string, string>,
	modelId: string,
): Promise<Record<string, unknown>> {
	const response = await fetchWithTimeout(`${base}/chat/completions`, {
		method: "POST",
		headers: { ...headers, "Content-Type": "application/json" },
		body: JSON.stringify({
			model: modelId,
			messages: [{ role: "user", content: "ping" }],
			max_tokens: 1,
		}),
	})
	if (response.ok) return { valid: true, method: "chat" }
	return { valid: false, error: describeChatError(response.status), method: "chat" }
}

async function validateEmbedding(
	baseUrl: string,
	apiKey: string,
	modelId?: string,
): Promise<Record<string, unknown>> {
	if (!modelId?.trim()) return { valid: false, error: "Model ID required for embedding validation" }
	const response = await fetchWithTimeout(`${baseUrl.replace(/\/$/, "")}/embeddings`, {
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify({ model: modelId.trim(), input: "ping" }),
	})
	if (response.ok) {
		const data = await response.json().catch(() => null)
		const dimensions = Array.isArray(data?.data?.[0]?.embedding)
			? data.data[0].embedding.length
			: null
		return { valid: true, method: "embeddings", dimensions }
	}
	if (response.status === 401 || response.status === 403) {
		return { valid: false, error: "API key unauthorized" }
	}
	const body = await response.text().catch(() => "")
	return {
		valid: false,
		error: `Embeddings request failed (${response.status})${body ? `: ${body.slice(0, 200)}` : ""}`,
		method: "embeddings",
	}
}

async function validateAnthropic(
	baseUrl: string,
	apiKey: string,
	modelId?: string,
): Promise<Record<string, unknown>> {
	// The base URL is not the endpoint: the router appends `/messages`, so a URL
	// that already ends in it would be dialled twice.
	const trimmed = baseUrl.replace(/\/$/, "")
	const base = trimmed.endsWith("/messages") ? trimmed.slice(0, -"/messages".length) : trimmed
	const headers = {
		"x-api-key": apiKey,
		"anthropic-version": "2023-06-01",
		Authorization: `Bearer ${apiKey}`,
	}

	const response = await fetchWithTimeout(`${base}/models`, { headers })
	if (response.ok) return { valid: true }
	// An auth failure will not become a success against a different endpoint.
	if (response.status === 401 || response.status === 403) {
		return { valid: false, error: "API key unauthorized" }
	}
	if (modelId) return chatProbe(base, headers, modelId)
	return { valid: false, error: describeModelsError(response.status) }
}

async function validateOpenAi(
	baseUrl: string,
	apiKey: string,
	modelId?: string,
): Promise<Record<string, unknown>> {
	const base = baseUrl.replace(/\/$/, "")
	const headers = { Authorization: `Bearer ${apiKey}` }

	const response = await fetchWithTimeout(`${base}/models`, { headers })
	if (response.ok) return { valid: true }
	if (response.status === 401 || response.status === 403) {
		return { valid: false, error: "API key unauthorized" }
	}
	if (modelId) return chatProbe(base, headers, modelId)
	return { valid: false, error: describeModelsError(response.status) }
}

/**
 * Probe one node. The caller has already checked the URL's shape and that this
 * server may dial it; this only decides whether the key works.
 */
export async function validateBaseUrl(input: {
	baseUrl: string
	apiKey: string
	type: string
	modelId?: string
}): Promise<Record<string, unknown>> {
	try {
		if (input.type === "custom-embedding") {
			return await validateEmbedding(input.baseUrl, input.apiKey, input.modelId)
		}
		if (input.type === "anthropic-compatible") {
			return await validateAnthropic(input.baseUrl, input.apiKey, input.modelId)
		}
		return await validateOpenAi(input.baseUrl, input.apiKey, input.modelId)
	} catch (error) {
		return { valid: false, error: describeFetchError(error) }
	}
}
