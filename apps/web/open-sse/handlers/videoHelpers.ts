import { HTTP_STATUS } from "../config/runtimeConfig.ts"
import { PROVIDER_MEDIA } from "../providers/index.ts"
import { refreshTokenByProvider } from "../services/tokenRefresh.ts"
import type {
	Credentials,
	CredentialsRefreshedCallback,
	EngineLogger,
	MediaRequestPlan,
} from "../types.ts"
import { createErrorResult } from "../utils/error.ts"
import { getVideoAdapter } from "./videoProviders/index.ts"

// Upstream fetch deadline for video job submission/polling (the job itself is
// async upstream - this only bounds the HTTP round-trip, not video rendering).
const VIDEO_FETCH_TIMEOUT_MS = Number(process.env.VIDEO_FETCH_TIMEOUT_MS || 120000)

// POST /videos/* creates a billable upstream job. A network error after the
// request left the socket may still have created the job, so creation is NEVER
// auto-retried (the only re-send is the auth retry after a 401/403 refresh,
// which upstream rejects before job creation).
export function sanitizeSecrets(text, credentials = null) {
	if (!text) return text
	let out = String(text).replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
	for (const key of ["accessToken", "refreshToken", "apiKey"]) {
		const secret = credentials?.[key]
		if (typeof secret === "string" && secret.length >= 8) {
			out = out.split(secret).join("[redacted]")
		}
	}
	return out
}

export function buildUpstreamUrl(config, action, requestId) {
	const base = config.baseUrl.replace(/\/$/, "")
	return requestId ? `${base}/${encodeURIComponent(requestId)}` : `${base}/${action}`
}

export function buildHeaders({ token, contentType, idempotencyKey }): Record<string, string> {
	const headers: Record<string, string> = { Accept: "application/json" }
	if (token) headers.Authorization = `Bearer ${token}`
	if (contentType) headers["Content-Type"] = contentType
	if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey
	return headers
}

export function combineSignals(signal, timeoutMs) {
	const timeoutSignal =
		typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : null
	if (signal && timeoutSignal && typeof AbortSignal.any === "function") {
		return AbortSignal.any([signal, timeoutSignal])
	}
	return signal || timeoutSignal || undefined
}

/**
 * Transparent proxy for async video jobs (xAI Grok Imagine shape).
 *
 * - Forwards the raw body byte-for-byte (JSON or multipart) - no reshaping.
 * - Passes upstream JSON (request_id, status, video.url, error) back verbatim.
 * - 401/403 with a refresh token: refresh ONCE, retry ONCE. No other retry.
 * - Upstream error text is sanitized before it reaches the client.
 *
 * @param {object} options
 * @param {string} options.provider - Provider id (must have registry videoConfig)
 * @param {"generations"|"edits"|"extensions"|null} options.action - Creation action (POST)
 * @param {string|null} [options.requestId] - Poll target (GET /videos/{id})
 * @param {Buffer|string|null} [options.rawBody] - Exact body to forward
 * @param {string|null} [options.contentType] - Original Content-Type header
 * @param {string|null} [options.idempotencyKey] - Forwarded Idempotency-Key
 * @param {object} options.credentials - { accessToken?, apiKey?, refreshToken?, authType? }
 * @param {AbortSignal} [options.signal] - Client cancellation signal
 * @param {number} [options.timeoutMs]
 * @param {object} [options.log]
 * @param {function} [options.onCredentialsRefreshed]
 * @returns {Promise<{ success: boolean, response: Response, status?: number, error?: string }>}
 */
