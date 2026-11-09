/** Executor dispatch upstream-error recording. */
import { appendRequestLog, saveRequestDetail, trackPendingRequest } from "@/lib/usageDb"
import { createErrorResult, formatProviderError } from "../../utils/error.ts"
import { upstreamResponseHeaders } from "../../utils/upstreamHeaders.ts"
import { buildRequestDetail, extractRequestConfig, saveFailedUsage } from "./requestDetail.ts"

export async function recordUpstreamError(
	state,
): Promise<import("./executorDispatch.ts").ExecutorDispatchResult | undefined> {
	const {
		firstFailure,
		providerResponse,
		provider,
		connectionId,
		trackedModel,
		model,
		requestedModel,
		requestStartTime,
		body,
		stream,
		finalBody,
		translatedBody,
		pxpipeSummary,
		apiKey,
		clientRawRequest,
		log,
		reqTag,
		providerUrl,
		reqLogger,
		hideError,
	} = state
	{
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
