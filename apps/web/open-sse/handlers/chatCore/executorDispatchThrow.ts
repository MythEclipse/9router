/** Executor dispatch throw handling. */
import { appendRequestLog, saveRequestDetail, trackPendingRequest } from "@/lib/usageDb"
import { HTTP_STATUS } from "../../config/runtimeConfig.ts"
import { createErrorResult, formatProviderError } from "../../utils/error.ts"
import type { ExecutorDispatchContext, ExecutorDispatchResult } from "./executorDispatch.ts"
import { buildRequestDetail, extractRequestConfig, saveFailedUsage } from "./requestDetail.ts"

export async function executorThrowResult(
	ctx: ExecutorDispatchContext,
	error: Error,
): Promise<ExecutorDispatchResult> {
	const {
		trackedModel,
		provider,
		connectionId,
		requestStartTime,
		body,
		stream,
		translatedBody,
		pxpipeSummary,
		apiKey,
		clientRawRequest,
		log,
		reqTag,
		hideError,
		model,
		requestedModel,
		streamController,
	} = ctx
	{
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
			return {
				kind: "return",
				result: createErrorResult(499, "Request aborted"),
			} as ExecutorDispatchResult
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
}
