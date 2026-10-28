import { HTTP_STATUS } from "open-sse/config/runtimeConfig"
import { handleFetchCore } from "open-sse/handlers/fetch/index"
import { getComboModelsFromData, handleComboChat } from "open-sse/services/combo"
import { errorResponse } from "open-sse/utils/error"
import { getClientIp } from "@/lib/auth/loginLimiter"
import { getCombos, getSettings } from "@/lib/localDb"
import { AI_PROVIDERS, resolveProviderId } from "@/shared/constants/providers"
import { assertPublicUrlResolved } from "@/shared/utils/ssrfGuard"
import { unavailableCredentialResponse } from "../services/accountFallbackLoop.ts"
import {
	apiKeyGateFailure,
	clearAccountError,
	extractApiKey,
	getProviderCredentials,
	isValidApiKey,
	markAccountUnavailable,
	shouldLogAuthFailure,
	shouldTryNextAccount,
} from "../services/auth.ts"
import { enforceKeyAccessProvider, getKeyAccessContext } from "../services/keyAccess.ts"
import { checkAndRefreshToken } from "../services/tokenRefresh.ts"
import * as log from "../utils/logger.ts"

/**
 * Handle web fetch (URL extraction) request for the SSE/Next.js server.
 * Provider IS the model. Mirrors handleEmbeddings auth + fallback flow.
 *
 * @param {Request} request
 */
export async function handleFetch(request) {
	let body
	try {
		body = await request.json()
	} catch {
		log.warn("FETCH", "Invalid JSON body")
		return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body")
	}

	const reqUrl = new URL(request.url)
	// Accept either `provider` or `model` (UI sends `model` since provider IS the model for webFetch)
	const providerInput = body.provider || body.model
	const targetUrl = body.url
	const _format = body.format
	const _maxCharacters = body.max_characters

	log.request("POST", `${reqUrl.pathname} | ${providerInput}`)

	// Log API key (masked)
	const apiKey = extractApiKey(request)
	if (apiKey) {
		log.debug("AUTH", `API Key: ${log.maskKey(apiKey)}`)
	} else {
		log.debug("AUTH", "No API key provided (local mode)")
	}

	// Enforce API key if enabled in settings
	const settings = await getSettings()
	if (settings.requireApiKey && !apiKey) {
		if (shouldLogAuthFailure("fetch", getClientIp(request), null)) {
			log.warn("AUTH", "Missing API key (requireApiKey=true)")
		}
		return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key")
	}
	if (apiKey) {
		const failure = apiKeyGateFailure(await isValidApiKey(apiKey), settings.requireApiKey)
		if (failure) {
			if (shouldLogAuthFailure("fetch", getClientIp(request), apiKey.slice(0, 8))) {
				log.warn("AUTH", `${failure.message} (requireApiKey=${settings.requireApiKey})`)
			}
			return errorResponse(failure.status, failure.message)
		}
	}

	if (!providerInput || typeof providerInput !== "string") {
		log.warn("FETCH", "Missing provider/model")
		return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: provider (or model)")
	}

	if (!targetUrl || typeof targetUrl !== "string") {
		log.warn("FETCH", "Missing url")
		return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: url")
	}

	// Validate URL format
	try {
		new URL(targetUrl)
	} catch {
		log.warn("FETCH", "Invalid URL", { url: targetUrl })
		return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid URL format")
	}

	// SSRF guard: reject internal/private/metadata targets, including
	// hostnames that merely resolve to one (DNS lookup, not just literal checks).
	try {
		await assertPublicUrlResolved(targetUrl)
	} catch (err) {
		log.warn("FETCH", "Blocked URL", { url: targetUrl })
		return errorResponse(HTTP_STATUS.BAD_REQUEST, err.message)
	}

	// Combo expansion: providerInput may be a combo name → run fallback/round-robin across providers
	const combos = await getCombos()
	const comboModels = getComboModelsFromData(providerInput, combos)

	// Per-key access control: the provider IS the model here, so a
	// restricted key needs the provider id (or the combo) on its list.
	const keyAccessDenied = await enforceKeyAccessProvider(
		await getKeyAccessContext(request),
		providerInput,
		comboModels,
	)
	if (keyAccessDenied) return keyAccessDenied
	if (comboModels) {
		const comboStrategies = settings.comboStrategies || {}
		const comboStrategy =
			comboStrategies[providerInput]?.fallbackStrategy || settings.comboStrategy || "fallback"
		const comboStickyLimit = settings.comboStickyRoundRobinLimit
		log.info(
			"FETCH",
			`Combo "${providerInput}" with ${comboModels.length} providers (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`,
		)
		return handleComboChat({
			body,
			models: comboModels,
			handleSingleModel: (b, m) => handleSingleProviderFetch(b, m, request, apiKey, settings),
			log,
			comboName: providerInput,
			comboStrategy,
			comboStickyLimit,
		})
	}

	return handleSingleProviderFetch(body, providerInput, request, apiKey, settings)
}

async function handleSingleProviderFetch(body, providerInput, _request, _apiKey, _settings) {
	const targetUrl = body.url
	const format = body.format
	const maxCharacters = body.max_characters
	const providerId = resolveProviderId(providerInput)
	const resolvedProvider = AI_PROVIDERS[providerId]

	if (!resolvedProvider) {
		log.warn("FETCH", "Unknown provider", { provider: providerInput })
		return errorResponse(HTTP_STATUS.BAD_REQUEST, `Unknown provider: ${providerInput}`)
	}

	const providerConfig = resolvedProvider.fetchConfig
	if (!providerConfig) {
		log.warn("FETCH", "Provider does not support web fetch", { provider: providerId })
		return errorResponse(HTTP_STATUS.BAD_REQUEST, `Provider ${providerId} does not support web fetch`)
	}

	if (providerInput !== providerId) {
		log.info("ROUTING", `${providerInput} → ${providerId}`)
	} else {
		log.info("ROUTING", `Provider: ${providerId}`)
	}

	// No-auth fetch path (kept for parity though no current fetch provider sets noAuth)
	if (resolvedProvider.noAuth) {
		log.info("AUTH", `\x1b[32m${providerId} no-auth mode\x1b[0m`)
		const result = await handleFetchCore({
			url: targetUrl,
			format,
			maxCharacters,
			provider: resolvedProvider.id,
			providerConfig,
			credentials: null,
			log,
		})
		if (result.success) {
			return new Response(JSON.stringify(result.data), {
				headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
			})
		}
		return errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "Fetch failed")
	}

	// Credential + fallback loop
	const excludeConnectionIds = new Set<string>()
	let lastError = null
	let lastStatus = null

	// Keep web-fetch failures scoped to this capability. Providers such as
	// Ollama use the same connection for chat and fetch, so an upstream fetch
	// failure must not take the account offline for LLM requests.
	const fetchLockKey = `webfetch:${providerId}`

	while (true) {
		const credentials = await getProviderCredentials(providerId, excludeConnectionIds, fetchLockKey)

		const unavailable = unavailableCredentialResponse({
			credentials,
			excludeConnectionIds,
			lastError,
			lastStatus,
			subject: providerId,
			label: "FETCH",
		})
		if (unavailable) return unavailable

		log.info("AUTH", `\x1b[32mUsing ${providerId} account: ${credentials.connectionName}\x1b[0m`)

		const refreshedCredentials = await checkAndRefreshToken(providerId, credentials)

		// handleFetchCore takes no refresh callback and never refreshes: web-fetch
		// providers use static keys, so there is nothing to write back here.
		const result = await handleFetchCore({
			url: targetUrl,
			format,
			maxCharacters,
			provider: resolvedProvider.id,
			providerConfig,
			credentials: refreshedCredentials,
			log,
		})

		if (result.success) {
			await clearAccountError(credentials.connectionId, credentials, fetchLockKey)
			return new Response(JSON.stringify(result.data), {
				headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
			})
		}

		const { shouldFallback } = await markAccountUnavailable(
			credentials.connectionId,
			result.status,
			result.error,
			providerId,
			fetchLockKey,
		)

		if (shouldTryNextAccount(credentials.connectionId, result.status, shouldFallback)) {
			log.warn(
				"AUTH",
				`Account ${credentials.connectionName} unavailable (${result.status}), trying fallback`,
			)
			excludeConnectionIds.add(credentials.connectionId)
			lastError = result.error
			lastStatus = result.status
			continue
		}

		return errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "Fetch failed")
	}
}
