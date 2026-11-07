import { appendRequestLog, saveRequestDetail, trackPendingRequest } from "@/lib/usageDb"
import { HTTP_STATUS, RESPONSE_PARSE_RETRY_ATTEMPTS } from "../../config/runtimeConfig.ts"
import { refreshWithRetry } from "../../services/tokenRefresh.ts"
import {
	collectJsonFrames,
	isEventStreamResponse,
	looksLikeSseText,
} from "../../transformer/jsonToStreamConverter.ts"
import {
	degrade as degradeToolPayload,
	isToolCallRejection,
	TOOL_FALLBACK_MAX_LEVEL,
} from "../../translator/concerns/toolCallFallback.ts"
import { createErrorResult, formatProviderError, parseUpstreamError } from "../../utils/error.ts"
import { takeRenamedToolNames } from "../../utils/opencodeFingerprint.ts"
import { upstreamResponseHeaders } from "../../utils/upstreamHeaders.ts"
import type { LogSink } from "./options.ts"
import { buildRequestDetail, extractRequestConfig, saveFailedUsage } from "./requestDetail.ts"

/**
 * Check a successful buffered upstream response before handing it to a parser.
 * Streaming responses are deliberately checked only when the client has not
 * received a stream yet; once bytes are sent, replaying the request would
 * duplicate a partial answer.
 */
export async function responseBodyNeedsParseRetry(response) {
	// HTTP failures (including rate limits and upstream 5xx responses) must
	// follow the normal error/fallback path, never the malformed-body replay.
	if (!response?.ok || response.status >= 400) return false
	if (!response || typeof response.clone !== "function") return true
	let text = ""
	try {
		text = await response.clone().text()
	} catch {
		return true
	}
	if (!text.trim()) return true
	if (isEventStreamResponse(response) || looksLikeSseText(text)) {
		const frames = collectJsonFrames(text)
		if (frames.some((frame) => frame?.error || frame?.type === "error")) return false
		return frames.length === 0
	}
	try {
		const body = JSON.parse(text)
		// Some gateways incorrectly return an error envelope with HTTP 200.
		// Preserve it for the regular parser instead of replaying the request.
		if (body?.error || body?.type === "error" || body?.status === "error") return false
		return false
	} catch {
		return true
	}
}

/** Everything the dispatch step needs to call the executor and interpret the answer. */
export interface ExecutorDispatchContext {
	executor: any
	provider: string
	model: string
	trackedModel: string
	translatedBody: Record<string, unknown>
	stream: boolean
	credentials: Record<string, unknown>
	/** The resolved per-session id; forwarded to the executor on every retry. */
	sessionSeed: string
	clientTool: string | null
	proxyOptions: Record<string, unknown>
	providerOverrides: unknown
	targetFormat: string
	reqLogger: any
	reqTag: string
	log?: LogSink
	requestStartTime: number
	connectionId?: string
	requestedModel?: string
	apiKey?: string
	clientRawRequest?: { endpoint?: string; [key: string]: unknown }
	body: Record<string, unknown>
	pxpipeSummary: Record<string, unknown> | null
	toolCallFallbackEnabled?: boolean
	/** Set by the dispatch step when a refresh/re-dispatch renamed tools. */
	toolNameMap?: Map<string, unknown>
	/** Non-streaming clients (or streaming requests that never asked for SSE). */
	clientRequestedStreaming: boolean
	onCredentialsRefreshed?: (credentials: Record<string, unknown>) => void | Promise<void>
	streamController: {
		signal: AbortSignal
		handleError(error: unknown): void
		[key: string]: unknown
	}
	hideError?: boolean
}

type DispatchSuccess = {
	kind: "response"
	providerResponse: any
	providerUrl: any
	providerHeaders: any
	finalBody: any
	providerResponseFormat: string
	toolNameMap: any
}

/** The executor threw, the client aborted, or the upstream answered with an error. */
export type ExecutorDispatchResult = DispatchSuccess | { kind: "return"; result: unknown }

/**
 * Dispatch → refresh-retry → malformed-body retry → tool-fallback retry.
 *
 * Returns either a usable upstream `Response` or `{ kind: "return" }` carrying
 * the exact `Result` the handler must hand back to its caller. Every usage /
 * pending / request-log write that belongs to a failure happens here so the
 * caller's remaining job is purely response shaping.
 */
export async function dispatchExecutor(
	ctx: ExecutorDispatchContext,
): Promise<ExecutorDispatchResult> {
	const {
		executor,
		provider,
		model,
		trackedModel,
		translatedBody,
		stream,
		credentials,
		log,
		reqTag,
		reqLogger,
		proxyOptions,
		providerOverrides,
		clientTool,
		sessionSeed,
	} = ctx
	const {
		targetFormat,
		requestStartTime,
		connectionId,
		requestedModel,
		apiKey,
		clientRawRequest,
		body,
		pxpipeSummary,
		toolCallFallbackEnabled,
		hideError,
		streamController,
	} = ctx
	let { toolNameMap } = ctx

	// Execute request
	let providerResponse, providerUrl, providerHeaders, finalBody
	// Most executors return their registry format. Cursor AgentService is an
	// exception: it is decoded by the executor into OpenAI-compatible output.
	let providerResponseFormat = targetFormat
	try {
		const result = await executor.execute({
			model,
			body: translatedBody,
			stream,
			credentials,
			providerSessionId: sessionSeed,
			clientTool,
			signal: streamController.signal,
			log,
			reqTag,
			proxyOptions,
			providerOverrides,
		})
		providerResponse = result.response
		providerUrl = result.url
		providerHeaders = result.headers
		finalBody = result.transformedBody
		providerResponseFormat = result.responseFormat || targetFormat
		const renamedToolNames = takeRenamedToolNames(translatedBody)
		if (renamedToolNames?.size) {
			toolNameMap = new Map([...(toolNameMap || []), ...renamedToolNames])
		}
		reqLogger.logTargetRequest(providerUrl, providerHeaders, finalBody)
	} catch (error) {
		trackPendingRequest(trackedModel, provider, connectionId, false, true)
		appendRequestLog({
			model: trackedModel,
			provider,
			connectionId,
			status: `FAILED ${error.name === "AbortError" ? 499 : HTTP_STATUS.BAD_GATEWAY}`,
			requestedModel: model,
		}).catch(() => {})
		saveRequestDetail(
			buildRequestDetail({
				provider,
				model,
				connectionId,
				requestedModel,
				latency: { ttft: 0, total: Date.now() - requestStartTime },
				tokens: { prompt_tokens: 0, completion_tokens: 0 },
				request: extractRequestConfig(body, stream),
				providerRequest: translatedBody || null,
				response: {
					error: error.message || String(error),
					status: error.name === "AbortError" ? 499 : 502,
					thinking: null,
				},
				pxpipe: pxpipeSummary,
				status: "error",
			}),
		).catch(() => {})
		saveFailedUsage({
			provider,
			model,
			requestedModel,
			connectionId,
			apiKey,
			endpoint: clientRawRequest?.endpoint,
			statusCode: error.name === "AbortError" ? 499 : 502,
		})

		if (error.name === "AbortError") {
			streamController.handleError(error)
			return { kind: "return", result: createErrorResult(499, "Request aborted") }
		}
		const errMsg = formatProviderError(error, provider, model, HTTP_STATUS.BAD_GATEWAY)
		if (log?.errorLine) {
			log.errorLine(
				reqTag,
				"✗",
				`ERROR 502 · ${provider}/${model} · ${Date.now() - requestStartTime}ms\n    ${errMsg}${error.stack ? `\n    ${error.stack}` : ""}`,
			)
		}
		try {
			const { recordErrorLog } = await import("@/lib/localDb")
			recordErrorLog({
				provider,
				model,
				endpoint: clientRawRequest?.endpoint || "chat",
				statusCode: 502,
				errorMessage: errMsg,
				errorType: "executor_error",
				stack: error.stack || "",
			})
		} catch {
			/* fail open */
		}
		const isHideError = Boolean(hideError)
		return {
			kind: "return",
			result: createErrorResult(HTTP_STATUS.BAD_GATEWAY, errMsg, undefined, null, isHideError),
		}
	}

	// Handle 401/403 - try token refresh (skip for noAuth providers)
	if (
		!executor.noAuth &&
		(providerResponse.status === HTTP_STATUS.UNAUTHORIZED ||
			providerResponse.status === HTTP_STATUS.FORBIDDEN)
	) {
		try {
			// Mutate credentials after each successful refresh: rotating refresh_token
			// providers (xAI/grok-cli) issue a new RT on every refresh; without this,
			// refreshWithRetry's 2nd/3rd attempt reuses the already-consumed RT →
			// invalid_grant → auth_failed retryable=false.
			const newCredentials = await refreshWithRetry(
				async () => {
					const result = await executor.refreshCredentials(credentials, log)
					if (result?.refreshToken && result.refreshToken !== credentials.refreshToken) {
						if (result.accessToken) credentials.accessToken = result.accessToken
						credentials.refreshToken = result.refreshToken
					}
					return result
				},
				3,
				log,
			)
			if (newCredentials?.accessToken || newCredentials?.copilotToken) {
				if (log?.line) log.line(reqTag, "🔑", `TOKEN REFRESHED · ${provider}/${model}`)
				Object.assign(credentials, newCredentials)
				if (ctx.onCredentialsRefreshed) {
					try {
						await ctx.onCredentialsRefreshed(newCredentials)
					} catch (e) {
						log?.warn?.("TOKEN", `onCredentialsRefreshed failed: ${e.message}`)
					}
				}
				try {
					// The refresh retry legitimately passes no reqTag; keep it that way.
					const retryResult = await executor.execute({
						model,
						body: translatedBody,
						stream,
						credentials,
						providerSessionId: sessionSeed,
						clientTool,
						signal: streamController.signal,
						log,
						proxyOptions,
						providerOverrides,
					})
					if (retryResult.response.ok) {
						providerResponse = retryResult.response
						providerUrl = retryResult.url
						providerResponseFormat = retryResult.responseFormat || targetFormat
					}
				} catch {
					log?.warn?.("TOKEN", `${provider.toUpperCase()} | retry after refresh failed`)
				}
			} else {
				log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh failed`)
			}
		} catch (e) {
			log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh threw: ${e.message}`)
		}
	}

	let parseRetryCount = 0
	const retryMalformedResponse = async () => {
		while (
			providerResponse?.ok &&
			parseRetryCount < RESPONSE_PARSE_RETRY_ATTEMPTS &&
			(await responseBodyNeedsParseRetry(providerResponse))
		) {
			parseRetryCount += 1
			try {
				const retryResult = await executor.execute({
					model,
					body: translatedBody,
					stream,
					credentials,
					providerSessionId: sessionSeed,
					clientTool,
					signal: streamController.signal,
					log,
					// The refresh retry never carried the request tag; keep it that way.
					proxyOptions,
					providerOverrides,
				})
				providerResponse = retryResult.response
				providerUrl = retryResult.url
				providerHeaders = retryResult.headers
				finalBody = retryResult.transformedBody
				providerResponseFormat = retryResult.responseFormat || targetFormat
				reqLogger.logTargetRequest(providerUrl, providerHeaders, finalBody)
				log?.warn?.(
					"RETRY",
					`${provider.toUpperCase()} | ${model} | retried malformed response (${parseRetryCount}/${RESPONSE_PARSE_RETRY_ATTEMPTS})`,
				)
			} catch (error) {
				log?.warn?.(
					"RETRY",
					`${provider.toUpperCase()} | ${model} | parse retry failed: ${error?.message || error}`,
				)
				return false
			}
		}
		return parseRetryCount > 0
	}

	// Non-streaming responses are fully buffered before reaching the caller, so
	// an invalid document can be retried safely. For a streaming client, only
	// retry a non-SSE response before its first byte is forwarded.
	if (providerResponse?.ok && !ctx.clientRequestedStreaming) {
		await retryMalformedResponse()
	} else if (providerResponse?.ok && stream) {
		const initialText =
			typeof providerResponse.clone === "function"
				? await providerResponse
						.clone()
						.text()
						.catch(() => "")
				: ""
		if (!isEventStreamResponse(providerResponse) && !looksLikeSseText(initialText)) {
			await retryMalformedResponse()
		}
	}

	// Provider returned error
	if (!providerResponse.ok) {
		const firstFailure = await parseUpstreamError(providerResponse, executor)
		let toolFallbackRecovered = false

		// Tool fallback: a provider that refuses the tool payload outright would
		// otherwise hand the caller a tool error, and inside a combo it would spend
		// the whole chain on the same malformed shape. Re-dispatch with the tool
		// machinery relaxed one step at a time, stopping at the first level the
		// provider accepts. Only for rejections that actually name tools - a context
		// overflow or a policy refusal must still reach the caller untouched.
		if (
			toolCallFallbackEnabled &&
			Array.isArray(translatedBody.tools) &&
			translatedBody.tools.length > 0 &&
			isToolCallRejection(firstFailure.statusCode, firstFailure.message)
		) {
			for (let level = 1; level <= TOOL_FALLBACK_MAX_LEVEL; level++) {
				const fallbackBody = degradeToolPayload(translatedBody, level)
				if (!fallbackBody) break
				try {
					// No reqTag here - the original loop omitted it, and adding it would
					// change the tag the degraded retry logs under.
					const attempt = await executor.execute({
						model,
						body: fallbackBody,
						stream,
						credentials,
						providerSessionId: sessionSeed,
						clientTool,
						signal: streamController.signal,
						log,
						proxyOptions,
					})
					if (attempt.response.ok) {
						providerResponse = attempt.response
						providerUrl = attempt.url
						finalBody = attempt.transformedBody
						providerResponseFormat = attempt.responseFormat || targetFormat
						const renamed = takeRenamedToolNames(fallbackBody)
						if (renamed?.size) toolNameMap = new Map([...(toolNameMap || []), ...renamed])
						reqLogger.logTargetRequest(providerUrl, attempt.headers, finalBody)
						toolFallbackRecovered = true
						log?.info?.(
							"TOOLFALLBACK",
							`recovered at level ${level} · ${provider}/${model} · after ${firstFailure.statusCode}`,
						)
						break
					}
					log?.debug?.(
						"TOOLFALLBACK",
						`level ${level} rejected · ${provider}/${model} · ${attempt.response.status}`,
					)
				} catch (e) {
					log?.debug?.("TOOLFALLBACK", `level ${level} threw · ${provider}/${model} · ${e.message}`)
				}
			}
		}

		if (!toolFallbackRecovered) {
			trackPendingRequest(trackedModel, provider, connectionId, false, true)
			const { statusCode, message, resetsAtMs } = firstFailure
			appendRequestLog({
				model: trackedModel,
				provider,
				connectionId,
				status: `FAILED ${statusCode}`,
				requestedModel: model,
			}).catch(() => {})
			saveRequestDetail(
				buildRequestDetail({
					provider,
					model,
					connectionId,
					requestedModel,
					latency: { ttft: 0, total: Date.now() - requestStartTime },
					tokens: { prompt_tokens: 0, completion_tokens: 0 },
					request: extractRequestConfig(body, stream),
					providerRequest: finalBody || translatedBody || null,
					response: { error: message, status: statusCode, thinking: null },
					pxpipe: pxpipeSummary,
					status: "error",
				}),
			).catch(() => {})
			saveFailedUsage({
				provider,
				model,
				requestedModel,
				connectionId,
				apiKey,
				endpoint: clientRawRequest?.endpoint,
				statusCode,
			})

			const errMsg = formatProviderError(new Error(message), provider, model, statusCode)
			if (log?.errorLine) {
				const urlStr = providerUrl ? `\n    URL: ${providerUrl}` : ""
				log.errorLine(
					reqTag,
					"✗",
					`ERROR ${statusCode} · ${provider}/${model} · ${Date.now() - requestStartTime}ms${urlStr}\n    ${errMsg}`,
				)
			}
			reqLogger.logError(new Error(message), finalBody || translatedBody)
			try {
				const { recordErrorLog } = await import("@/lib/localDb")
				recordErrorLog({
					provider,
					model,
					endpoint: clientRawRequest?.endpoint || "chat",
					statusCode,
					errorMessage: errMsg,
					errorType: "upstream_error",
				})
			} catch {
				/* fail open */
			}
			const isHideError = Boolean(hideError)
			return {
				kind: "return",
				result: createErrorResult(
					statusCode,
					errMsg,
					resetsAtMs,
					upstreamResponseHeaders(providerResponse.headers),
					isHideError,
				),
			}
		}
	}

	return {
		kind: "response",
		providerResponse,
		providerUrl,
		providerHeaders,
		finalBody,
		providerResponseFormat,
		toolNameMap,
	}
}
