/**
 * The Codex reset-credit port.
 *
 * Four of these six calls already existed as helpers elsewhere; what did not exist was a single
 * place that says "this is everything the reset-credit flow is allowed to touch". Keeping them
 * here means the use-case can be exercised — including both retry paths — without a database, an
 * OAuth provider or a network.
 */
// Ensure proxyFetch is loaded to patch globalThis.fetch.
import "open-sse/index"

import type {
	CodexConnection,
	CodexResetPort,
	ProxyOptions,
} from "9router-api/application/codex-reset-credits/reset-credits"
import {
	consumeCodexRateLimitResetCredit,
	getCodexRateLimitResetCredits,
} from "open-sse/services/usage"
import { getProviderConnectionById } from "@/lib/localDb"
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy"
import { refreshAndUpdateCredentials } from "@/lib/usage/connectionRefresh"

export const codexResetPort: CodexResetPort = {
	connection: async (id) => (await getProviderConnectionById(id)) as CodexConnection | null,
	proxyOptions: async (connection) =>
		(await resolveConnectionProxyConfig(
			connection.providerSpecificData as Record<string, unknown>,
		)) as ProxyOptions,
	refresh: async (connection, force, proxyOptions) =>
		(await refreshAndUpdateCredentials(connection, force, proxyOptions)) as {
			readonly connection: CodexConnection
		},
	readCredits: (accessToken, proxyOptions, providerSpecificData) =>
		getCodexRateLimitResetCredits(accessToken, proxyOptions, providerSpecificData),
	redeemCredit: (accessToken, requestId, proxyOptions) =>
		consumeCodexRateLimitResetCredit(accessToken, requestId, proxyOptions),
	newRequestId: () => crypto.randomUUID(),
}
