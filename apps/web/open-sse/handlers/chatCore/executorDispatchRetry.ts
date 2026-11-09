/** Executor dispatch retry. */
import { RESPONSE_PARSE_RETRY_ATTEMPTS } from "../../config/runtimeConfig.ts"
import { responseBodyNeedsParseRetry } from "./executorDispatch.ts"

export async function retryMalformedResponse(state) {
	const {
		executor,
		model,
		translatedBody,
		stream,
		credentials,
		sessionSeed,
		clientTool,
		streamController,
		log,
		proxyOptions,
		providerOverrides,
		reqLogger,
		provider,
		targetFormat,
	} = state
	let parseRetryCount = 0
	while (
		state.providerResponse?.ok &&
		parseRetryCount < RESPONSE_PARSE_RETRY_ATTEMPTS &&
		(await responseBodyNeedsParseRetry(state.providerResponse))
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
				proxyOptions,
				providerOverrides,
			})
			state.providerResponse = retryResult.response
			state.providerUrl = retryResult.url
			state.providerHeaders = retryResult.headers
			state.finalBody = retryResult.transformedBody
			state.providerResponseFormat = retryResult.responseFormat || targetFormat
			reqLogger.logTargetRequest(state.providerUrl, state.providerHeaders, state.finalBody)
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
