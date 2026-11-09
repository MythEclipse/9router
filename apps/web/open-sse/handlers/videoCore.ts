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

import { buildHeaders, buildUpstreamUrl, combineSignals, sanitizeSecrets } from "./videoHelpers.ts"
// POST /videos/* creates a billable upstream job. A network error after the
// request left the socket may still have created the job, so creation is NEVER
// auto-retried (the only re-send is the auth retry after a 401/403 refresh,
// which upstream rejects before job creation).
import {
	executeExecutorDrivenVideo,
	getVideoConfig,
	isExecutorDrivenVideo,
} from "./videoProviders.ts"

export { sanitizeSecrets } from "./videoHelpers.ts"
export {
	executeExecutorDrivenVideo,
	getVideoConfig,
	isExecutorDrivenVideo,
} from "./videoProviders.ts"
export const VIDEO_ACTIONS = new Set(["generations", "edits", "extensions"])

export interface VideoProxyOptions {
	/** Provider id (must have registry videoConfig). */
	provider: string
	/** Creation action (POST); null for a poll. */
	action?: string | null
	/** Poll target (GET /videos/{id}). */
	requestId?: string | null
	/** Exact body to forward. */
	rawBody?: string | Buffer | null
	/** Original Content-Type header. */
	contentType?: string | null
	/** Forwarded Idempotency-Key. */
	idempotencyKey?: string | null
	credentials: Credentials
	/** Client cancellation signal. */
	signal?: AbortSignal | null
	timeoutMs?: number
	log?: EngineLogger
	onCredentialsRefreshed?: CredentialsRefreshedCallback
}

export async function handleVideoProxyCore({
	provider,
	action = null,
	requestId = null,
	rawBody = null,
	contentType = null,
	idempotencyKey = null,
	credentials,
	signal,
	timeoutMs = VIDEO_FETCH_TIMEOUT_MS,
	log,
	onCredentialsRefreshed,
}: VideoProxyOptions) {
	// Executor-driven providers (browser-automation web providers, e.g.
	// muse-web): the registry marks them with videoConfig.executorDriven and the
	// executor's generateMedia() produces the video synchronously as base64.
	// "generations" = text-to-video; "edits" = image-to-video (input images
	// are attached to the agent thread before the prompt).
	if (
		isExecutorDrivenVideo(provider) &&
		!requestId &&
		(action === "generations" || action === "edits")
	) {
		return executeExecutorDrivenVideo({
			provider,
			rawBody,
			credentials,
			signal,
			log,
			onCredentialsRefreshed,
		})
	}

	const config = getVideoConfig(provider)
	if (!config) {
		return createErrorResult(
			HTTP_STATUS.BAD_REQUEST,
			`Provider '${provider}' does not support video generation`,
		)
	}
	if (!requestId && !VIDEO_ACTIONS.has(action)) {
		return createErrorResult(HTTP_STATUS.BAD_REQUEST, `Unknown video action: ${action}`)
	}

	const adapter = getVideoAdapter(provider)
	const fetchSignal = combineSignals(signal, timeoutMs)

	// Default (xAI shape) request plan; adapters override URL/method/headers/body.
	const defaultPlan = () => {
		const method = requestId ? "GET" : "POST"
		return {
			method,
			url: buildUpstreamUrl(config, action, requestId),
			headers: buildHeaders({
				token: credentials?.accessToken || credentials?.apiKey,
				contentType: method === "POST" ? contentType : null,
				idempotencyKey: method === "POST" ? idempotencyKey : null,
			}),
			body: method === "POST" ? rawBody : undefined,
		}
	}

	// Rebuilt per attempt so the auth retry below picks up the refreshed token.
	const doFetch = async (): Promise<{ planError?: string; response?: Response }> => {
		const plan: MediaRequestPlan | null = adapter
			? await adapter.buildRequest({
					config,
					action,
					requestId,
					rawBody,
					contentType,
					idempotencyKey,
					credentials,
					log,
					token: credentials?.accessToken || credentials?.apiKey,
				})
			: defaultPlan()
		if (plan.error) return { planError: plan.error }
		return {
			response: await fetch(plan.url, {
				method: plan.method,
				headers: plan.headers,
				body: plan.body as BodyInit | null | undefined,
				signal: fetchSignal,
			}),
		}
	}

	const method = requestId ? "GET" : "POST"
	let upstream
	try {
		const first = await doFetch()
		if (first.planError)
			return createErrorResult(HTTP_STATUS.BAD_REQUEST, `[${provider}] ${first.planError}`)
		upstream = first.response
	} catch (error) {
		if (error?.name === "AbortError" || error?.name === "TimeoutError") {
			return createErrorResult(
				HTTP_STATUS.REQUEST_TIMEOUT,
				`[${provider}] video ${method} aborted: ${error.message}`,
			)
		}
		// Never re-send a creation POST on network error - the job may already exist upstream.
		return createErrorResult(
			HTTP_STATUS.BAD_GATEWAY,
			sanitizeSecrets(`[${provider}] video upstream fetch failed: ${error.message}`, credentials),
		)
	}

	// 401/403 → refresh once → retry once (OAuth accounts only; API keys can't refresh)
	if (
		(upstream.status === HTTP_STATUS.UNAUTHORIZED || upstream.status === HTTP_STATUS.FORBIDDEN) &&
		credentials?.refreshToken
	) {
		let refreshed = null
		try {
			refreshed = await refreshTokenByProvider(provider, credentials, log)
		} catch (error) {
			log?.warn?.(
				"TOKEN",
				`${provider} | video refresh error: ${sanitizeSecrets(error.message, credentials)}`,
			)
		}
		if (refreshed?.accessToken) {
			log?.info?.("TOKEN", `${provider.toUpperCase()} | refreshed for video ${method}`)
			Object.assign(credentials, refreshed)
			if (onCredentialsRefreshed) await onCredentialsRefreshed(refreshed)
			try {
				await upstream.body?.cancel?.()
			} catch {
				/* noop */
			}
			try {
				const retry = await doFetch()
				if (retry.planError)
					return createErrorResult(HTTP_STATUS.BAD_REQUEST, `[${provider}] ${retry.planError}`)
				upstream = retry.response
			} catch (error) {
				return createErrorResult(
					HTTP_STATUS.BAD_GATEWAY,
					sanitizeSecrets(
						`[${provider}] video retry after refresh failed: ${error.message}`,
						credentials,
					),
				)
			}
		} else {
			log?.warn?.("TOKEN", `${provider.toUpperCase()} | video refresh failed - account needs re-auth`)
		}
	}

	const bodyText = await upstream.text().catch(() => "")

	if (!upstream.ok) {
		const message = sanitizeSecrets(bodyText || `HTTP ${upstream.status}`, credentials)
		return createErrorResult(upstream.status, `[${provider}] ${message.slice(0, 2000)}`)
	}

	// Success: pass the upstream JSON through untouched (request_id / status / video.url),
	// unless the adapter maps a provider-native shape onto it (Vertex operations).
	let outBody = bodyText
	let outType = upstream.headers.get("content-type") || "application/json"
	if (adapter?.transformResponse) {
		try {
			outBody = JSON.stringify(adapter.transformResponse(JSON.parse(bodyText)))
			outType = "application/json"
		} catch {
			// Non-JSON or unexpected shape - fall back to the raw upstream body.
		}
	}

	return {
		success: true as const,
		response: new Response(outBody, {
			status: upstream.status,
			headers: {
				"Content-Type": outType,
				"Access-Control-Allow-Origin": "*",
			},
		}),
	}
}
