// Ensure proxyFetch is loaded to patch globalThis.fetch
import "open-sse/index"

import {
	authExpiryVerdict,
	canReadConnectionUsage,
	connectionAfterRefresh,
	customQuotaConnection,
	isOAuthConnection,
	NOT_AVAILABLE_MESSAGE,
	quotaProxyOptions,
	refreshFailureMessage,
	tokenUpdateFromRefresh,
} from "9router-api/domain/connection-usage"
import { getExecutor } from "open-sse/executors/index"
import { isUnrecoverableRefreshError } from "open-sse/services/tokenRefresh"
import { getUsageForProvider } from "open-sse/services/usage"
import { isCustomQuotaProvider } from "open-sse/services/usage/customCredits"
import { getProviderConnectionById, updateProviderConnection } from "@/lib/localDb"
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy"
import { getProviderNodeById } from "@/models"
import { USAGE_APIKEY_PROVIDERS } from "@/shared/constants/providers"

export const dynamic = "force-dynamic"

/**
 * Refresh credentials using the executor and persist them.
 *
 * Transport plus persistence; the *shape* of the update and its merge rules are
 * `tokenUpdateFromRefresh` in `domain/connection-usage.ts`. Exported because
 * `codex-reset-credits/route.ts` drives the same refresh, and two copies would drift on
 * exactly the field that matters: OpenAI rotates the refresh token on every refresh, so
 * refreshing from a stale snapshot revokes the whole session and logs the account out.
 */
export async function refreshAndUpdateCredentials(connection, force = false, proxyOptions = null) {
	// Re-read the latest tokens before deciding anything: see the note above.
	const latest = connection.id ? await getProviderConnectionById(connection.id) : null
	if (latest) connection = latest

	const executor = getExecutor(connection.provider)

	const credentials = {
		accessToken: connection.accessToken,
		refreshToken: connection.refreshToken,
		idToken: connection.idToken,
		expiresAt: connection.expiresAt || connection.tokenExpiresAt,
		lastRefreshAt: connection.lastRefreshAt,
		connectionId: connection.id,
		providerSpecificData: connection.providerSpecificData,
		// For GitHub
		copilotToken: connection.providerSpecificData?.copilotToken,
		copilotTokenExpiresAt: connection.providerSpecificData?.copilotTokenExpiresAt,
	}

	// Check if refresh is needed (skip when force=true)
	if (!force && !executor.needsRefresh(credentials)) {
		return { connection, refreshed: false }
	}

	const refreshResult = await executor.refreshCredentials(credentials, console, proxyOptions)

	// Refresh token reused/invalidated — the token family is revoked; do not continue with
	// the dead token.
	if (refreshResult && isUnrecoverableRefreshError(refreshResult)) {
		throw new Error("Refresh token invalid or reused. Please re-authorize the connection.")
	}

	if (!refreshResult) {
		// Refresh failed but the existing access token may still work.
		if (connection.accessToken) return { connection, refreshed: false }
		throw new Error("Failed to refresh credentials. Please re-authorize the connection.")
	}

	const updateData = tokenUpdateFromRefresh({
		refresh: refreshResult,
		existingProviderSpecificData: connection.providerSpecificData,
		now: Date.now(),
	})

	await updateProviderConnection(connection.id, updateData)

	return {
		connection: connectionAfterRefresh(connection, updateData),
		refreshed: true,
	}
}

/**
 * GET /api/usage/[connectionId] - quota for one connection.
 *
 * The eligibility rules, the expiry verdict and the proxy options all come from
 * `domain/connection-usage.ts`; this handler resolves the connection and calls upstream.
 */
export async function GET(request, { params }) {
	let connection
	try {
		const { connectionId } = await params
		const force = new URL(request.url).searchParams.get("force") === "1"

		connection = await getProviderConnectionById(connectionId)
		if (!connection) {
			return Response.json({ error: "Connection not found" }, { status: 404 })
		}

		// Compatible nodes opt in to the standard quota endpoint on the node itself. Merging
		// the node's settings into the connection lets the usage handler use the same base URL
		// and quota path the provider was configured with.
		let customQuotaNode = null
		if (isCustomQuotaProvider(connection.provider)) {
			customQuotaNode = await getProviderNodeById(connection.provider)
			if (!customQuotaNode?.quotaEnabled) {
				return Response.json({ message: NOT_AVAILABLE_MESSAGE })
			}
			connection = customQuotaConnection(connection, customQuotaNode)
		}

		const isOAuth = isOAuthConnection(connection)
		if (
			!canReadConnectionUsage({
				connection,
				customQuotaEnabled: customQuotaNode?.quotaEnabled === true,
				usageApiKeyProviders: USAGE_APIKEY_PROVIDERS,
			})
		) {
			return Response.json({ message: NOT_AVAILABLE_MESSAGE })
		}

		const proxyOptions = quotaProxyOptions(
			await resolveConnectionProxyConfig(connection.providerSpecificData),
		)

		// Only OAuth connections can be refreshed; an API key has no token to renew.
		if (isOAuth) {
			try {
				const result = await refreshAndUpdateCredentials(connection, false, proxyOptions)
				connection = result.connection
			} catch (refreshError) {
				console.error("[Usage API] Credential refresh failed:", refreshError)
				return Response.json(
					{ error: `Credential refresh failed: ${refreshError.message}` },
					{ status: 401 },
				)
			}
		}

		let usage = await getUsageForProvider(connection, proxyOptions, { force })

		// Some providers answer the quota call with an "expired" body instead of a 401.
		const verdict = authExpiryVerdict({
			usage,
			isOAuth,
			hasRefreshToken: Boolean(connection.refreshToken),
		})
		if (verdict.kind === "retry-after-refresh") {
			try {
				const retryResult = await refreshAndUpdateCredentials(connection, true, proxyOptions)
				connection = retryResult.connection
				usage = await getUsageForProvider(connection, proxyOptions, { force })
			} catch (retryError) {
				console.warn(refreshFailureMessage(connection.provider, retryError))
			}
		} else if (verdict.kind === "reauthorize") {
			return Response.json({ error: verdict.message }, { status: 401 })
		}

		return Response.json(usage)
	} catch (error) {
		const provider = connection?.provider ?? "unknown"
		console.warn(`[Usage] ${provider}: ${error.message}`)
		return Response.json({ error: error.message }, { status: 500 })
	}
}
