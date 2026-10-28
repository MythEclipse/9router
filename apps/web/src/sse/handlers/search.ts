import { HTTP_STATUS } from "open-sse/config/runtimeConfig"
import { handleSearchCore } from "open-sse/handlers/search/index"
import { getComboModelsFromData, handleComboChat } from "open-sse/services/combo"
import { errorResponse } from "open-sse/utils/error"
import { getClientIp } from "@/lib/auth/loginLimiter"
import { getCombos, getSettings } from "@/lib/localDb"
import { AI_PROVIDERS, resolveProviderId } from "@/shared/constants/providers"
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

/** The error arm of a searchCore result. */
interface SearchFailure {
	success: false
	status: number
	error: string
	response: Response
}

/**
 * Handle web search request for the SSE/Next.js server.
 * Provider IS the model (no model field). Mirrors handleEmbeddings auth + fallback flow.
 *
 * @param {Request} request
 */
export async function handleSearch(request) {
	let body
	try {
		body = await request.json()
	} catch {
		log.warn("SEARCH", "Invalid JSON body")
		return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body")
	}

	const url = new URL(request.url)
	// Accept either `provider` or `model` (UI sends `model` since provider IS the model for webSearch)
	const providerInput = body.provider || body.model
	const query = body.query

	log.request("POST", `${url.pathname} | ${providerInput}`)

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
		if (shouldLogAuthFailure("search", getClientIp(request), null)) {
			log.warn("AUTH", "Missing API key (requireApiKey=true)")
		}
		return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key")
	}
	if (apiKey) {
		const failure = apiKeyGateFailure(await isValidApiKey(apiKey), settings.requireApiKey)
		if (failure) {
			if (shouldLogAuthFailure("search", getClientIp(request), apiKey.slice(0, 8))) {
				log.warn("AUTH", `${failure.message} (requireApiKey=${settings.requireApiKey})`)
			}
			return errorResponse(failure.status, failure.message)
		}
	}

	if (!providerInput || typeof providerInput !== "string") {
		log.warn("SEARCH", "Missing provider/model")
		return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: provider (or model)")
	}

	if (!query || typeof query !== "string" || !query.trim()) {
		log.warn("SEARCH", "Missing query")
		return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: query")
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
			"SEARCH",
			`Combo "${providerInput}" with ${comboModels.length} providers (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`,
		)
		return handleComboChat({
			body,
			models: comboModels,
			handleSingleModel: (b, m) => handleSingleProviderSearch(b, m, request, apiKey, settings),
			log,
			comboName: providerInput,
			comboStrategy,
			comboStickyLimit,
		})
	}

	return handleSingleProviderSearch(body, providerInput, request, apiKey, settings)
}

async function handleSingleProviderSearch(body, providerInput, _request, _apiKey, _settings) {
	const query = body.query
	const providerId = resolveProviderId(providerInput)
	const resolvedProvider = AI_PROVIDERS[providerId]

	if (!resolvedProvider) {
		log.warn("SEARCH", "Unknown provider", { provider: providerInput })
		return errorResponse(HTTP_STATUS.BAD_REQUEST, `Unknown provider: ${providerInput}`)
	}

	const providerConfig = resolvedProvider.searchConfig
	const supportsSearch = !!providerConfig || !!resolvedProvider.searchViaChat

	if (!supportsSearch) {
		log.warn("SEARCH", "Provider does not support web search", { provider: providerId })
		return errorResponse(
			HTTP_STATUS.BAD_REQUEST,
			`Provider ${providerId} does not support web search`,
		)
	}

	if (providerInput !== providerId) {
		log.info("ROUTING", `${providerInput} → ${providerId}`)
	} else {
		log.info("ROUTING", `Provider: ${providerId}`)
	}

	// Sanitized body forwarded to core
	const coreBody = {
		query: query.trim(),
		provider: providerId,
		max_results: body.max_results,
		search_type: body.search_type,
		country: body.country,
		language: body.language,
		time_range: body.time_range,
		offset: body.offset,
		domain_filter: body.domain_filter,
		content_options: body.content_options,
		provider_options: body.provider_options,
	}

	// No-auth providers (e.g. searxng) bypass credential lookup
	if (resolvedProvider.noAuth) {
		log.info("AUTH", `\x1b[32m${providerId} no-auth mode\x1b[0m`)
		const result = await handleSearchCore({
			body: coreBody,
			provider: resolvedProvider,
			providerConfig,
			credentials: null,
			log,
		})
		if (result.success) return result.response
		return result.response
	}

	// Credential + fallback loop
	const excludeConnectionIds = new Set<string>()
	let lastError = null
	let lastStatus = null

	// Credential fallback: some search providers reuse the API key of a related
	// chat provider (e.g. ollama-search reuses the `ollama` chat key, zai-search
	// reuses the `glm` chat key). When the search provider has no own connection,
	// fall back to the linked provider's credentials.
	const fallbackProviderId = resolvedProvider.credentialFallback

	// Lock scope for this handler. Without it markAccountUnavailable would write
	// an account-wide `__all` lock, which on the credentialFallback path takes
	// the shared chat key (e.g. glm) offline for chat as well. Must be passed to
	// getProviderCredentials too, so the lock is read back under the same key.
	const searchLockKey = `websearch:${providerId}`

	while (true) {
		// Provider that actually owns the connection in use - differs from
		// providerId once we fall back, and error locks must be attributed to it.
		let credentialProviderId = providerId
		let credentials = await getProviderCredentials(providerId, excludeConnectionIds, searchLockKey)

		// Fall back to the related chat provider's credentials when this search
		// provider has none of its own (one key, chat + search).
		if (!credentials && fallbackProviderId) {
			credentials = await getProviderCredentials(
				fallbackProviderId,
				excludeConnectionIds,
				searchLockKey,
			)
			if (credentials) {
				credentialProviderId = fallbackProviderId
				log.info("AUTH", `\x1b[32m${providerId} reusing ${fallbackProviderId} credentials\x1b[0m`)
			}
		}

		const unavailable = unavailableCredentialResponse({
			credentials,
			excludeConnectionIds,
			lastError,
			lastStatus,
			subject: providerId,
			label: "SEARCH",
		})
		if (unavailable) return unavailable

		log.info("AUTH", `\x1b[32mUsing ${providerId} account: ${credentials.connectionName}\x1b[0m`)

		const refreshedCredentials = await checkAndRefreshToken(providerId, credentials)

		// handleSearchCore takes no refresh callback and never refreshes: search
		// providers use static keys, so there is nothing to write back here.
		const result = await handleSearchCore({
			body: coreBody,
			provider: resolvedProvider,
			providerConfig,
			credentials: refreshedCredentials,
			log,
		})

		if (result.success) {
			// A success clears this search lock, never the account-wide one.
			await clearAccountError(credentials.connectionId, credentials, searchLockKey)
			return result.response
		}

		// A failed result is the error envelope: status/error are present.
		const failure = result as SearchFailure
		const { shouldFallback } = await markAccountUnavailable(
			credentials.connectionId,
			failure.status,
			failure.error,
			credentialProviderId,
			searchLockKey,
		)

		if (shouldTryNextAccount(credentials.connectionId, failure.status, shouldFallback)) {
			log.warn(
				"AUTH",
				`Account ${credentials.connectionName} unavailable (${failure.status}), trying fallback`,
			)
			excludeConnectionIds.add(credentials.connectionId)
			lastError = failure.error
			lastStatus = failure.status
			continue
		}

		return failure.response
	}
}
