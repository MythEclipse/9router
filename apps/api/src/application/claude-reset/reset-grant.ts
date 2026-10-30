/**
 * Spending one Claude limit-reset grant.
 *
 * The sequence mirrors `codex-reset-credits`: resolve the row, refresh the OAuth credential so
 * upstream sees a live token, then make the one call that matters. It is not shared with that
 * module because the shapes differ — a grant is spent by an id the caller supplies, a credit is
 * redeemed with a server-minted one — and a shared "reset" abstraction over two different upstream
 * contracts would be harder to read than two short flows.
 *
 * The grant is irreversible, so the eligibility check runs before the refresh: a caller who picked
 * the wrong connection should not cost a token refresh on the way to being told no.
 */
import {
	type ClaudeResetOutcome,
	type ClaudeResetResult,
	claudeResetEligibility,
	claudeResetOutcome,
} from "../../domain/claude-reset.ts"

export type ClaudeConnection = Record<string, unknown>

export type ProxyOptions = Record<string, unknown>

/** What this flow needs from the outside world. */
export interface ClaudeResetPort {
	readonly connection: (id: string) => Promise<ClaudeConnection | null | undefined>
	readonly proxyOptions: (connection: ClaudeConnection) => Promise<ProxyOptions>
	readonly refresh: (
		connection: ClaudeConnection,
		force: boolean,
		proxyOptions: ProxyOptions,
	) => Promise<{ readonly connection: ClaudeConnection }>
	readonly spendGrant: (
		accessToken: unknown,
		grantId: unknown,
		proxyOptions: ProxyOptions,
	) => Promise<ClaudeResetResult>
}

export type ClaudeResetAnswer = ClaudeResetOutcome

const messageOf = (error: unknown): string =>
	(error as { message?: string })?.message ?? String(error)

/** The four proxy fields the upstream call expects, defaulted the way the route always did. */
const proxyOptionFields = (config: ProxyOptions): ProxyOptions => ({
	connectionProxyEnabled: config.connectionProxyEnabled === true,
	connectionProxyUrl: config.connectionProxyUrl || "",
	connectionNoProxy: config.connectionNoProxy || "",
	vercelRelayUrl: config.vercelRelayUrl || "",
	strictProxy: false,
})

export async function spendResetGrant(
	connectionId: unknown,
	grantId: unknown,
	port: ClaudeResetPort,
): Promise<ClaudeResetAnswer> {
	try {
		const row = await port.connection(String(connectionId ?? ""))
		const verdict = claudeResetEligibility(row)
		// `ok: true` carries a connection and no status; the two arms do not share fields, so the
		// narrowing has to be on `ok` explicitly rather than on its absence.
		if (verdict.ok === false) {
			return { status: verdict.status, body: { error: verdict.message } }
		}

		const proxyOptions = proxyOptionFields(await port.proxyOptions(row as ClaudeConnection))
		const refreshed = await port.refresh(row as ClaudeConnection, false, proxyOptions)
		const result = await port.spendGrant(refreshed.connection.accessToken, grantId, proxyOptions)

		return claudeResetOutcome(result)
	} catch (error) {
		console.warn(`[Claude Reset] ${messageOf(error)}`)
		return { status: 500, body: { error: messageOf(error) } }
	}
}
