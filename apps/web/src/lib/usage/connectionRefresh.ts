/**
 * Refreshing and persisting a provider connection's credentials.
 *
 * This lived as an `export` inside `api/usage/[connectionId]/route.ts` and was imported by
 * `codex-reset-credits/route.ts` — a route reaching into another route for a transport helper,
 * which is the shape that drifts. It is here now so both routes and the oRPC connection-usage
 * use-case share one copy.
 *
 * The one rule that must never move or be duplicated: **re-read the row by id before deciding
 * anything.** OpenAI rotates the refresh token on every refresh, so refreshing from a snapshot
 * taken a moment earlier revokes the token family and logs the account out. The read below is
 * not an optimisation; it is the correctness of the whole operation.
 *
 * The *shape* of the update and its merge rules stay in `domain/connection-usage.ts`
 * (`tokenUpdateFromRefresh`, `connectionAfterRefresh`); this file is transport plus persistence.
 */
import "open-sse/index"

import { connectionAfterRefresh, tokenUpdateFromRefresh } from "9router-api/domain/connection-usage"
import { getExecutor } from "open-sse/executors/index"
import { isUnrecoverableRefreshError } from "open-sse/services/tokenRefresh"
import { getProviderConnectionById, updateProviderConnection } from "@/lib/localDb"

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
