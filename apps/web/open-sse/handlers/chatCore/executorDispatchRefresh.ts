/** Executor dispatch refresh retry. */

import { HTTP_STATUS } from "../../config/runtimeConfig.ts"
import { refreshWithRetry } from "../../services/tokenRefresh.ts"

export async function tryRefreshRetry(state) {
	const {
		ctx,
		executor,
		providerResponse,
		credentials,
		log,
		reqTag,
		provider,
		model,
		translatedBody,
		stream,
		sessionSeed,
		clientTool,
		streamController,
		proxyOptions,
		providerOverrides,
		targetFormat,
	} = state
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
						state.providerResponse = retryResult.response
						state.providerUrl = retryResult.url
						state.providerResponseFormat = retryResult.responseFormat || targetFormat
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

	return {
		providerResponse,
		providerUrl: state.providerUrl,
		providerResponseFormat: state.providerResponseFormat,
	}
}
