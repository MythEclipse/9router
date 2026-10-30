/**
 * The Claude limit-reset port.
 *
 * The same three calls the Codex reset flow needed, pointed at Claude's grant endpoint. Kept
 * separate rather than shared because a grant is spent by a caller-supplied id and answered with a
 * result object, while a credit is redeemed with a server-minted one — one abstraction over both
 * would have to lie about one of them.
 */
import "open-sse/index"

import type {
	ClaudeConnection,
	ClaudeResetPort,
	ProxyOptions,
} from "9router-api/application/claude-reset/reset-grant"
import type { ClaudeResetResult } from "9router-api/domain/claude-reset"
import { consumeClaudeResetGrant } from "open-sse/services/usage"
import { getProviderConnectionById } from "@/lib/localDb"
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy"
import { refreshAndUpdateCredentials } from "@/lib/usage/connectionRefresh"

export const claudeResetPort: ClaudeResetPort = {
	connection: async (id) => (await getProviderConnectionById(id)) as ClaudeConnection | null,
	proxyOptions: async (connection) =>
		(await resolveConnectionProxyConfig(
			connection.providerSpecificData as Record<string, unknown>,
		)) as ProxyOptions,
	refresh: async (connection, force, proxyOptions) =>
		(await refreshAndUpdateCredentials(connection, force, proxyOptions)) as {
			readonly connection: ClaudeConnection
		},
	spendGrant: async (accessToken, grantId, proxyOptions) =>
		(await consumeClaudeResetGrant(accessToken, grantId, proxyOptions)) as ClaudeResetResult,
}
