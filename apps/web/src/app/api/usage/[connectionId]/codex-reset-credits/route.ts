// Ensure proxyFetch is loaded to patch globalThis.fetch
import "open-sse/index"

import {
	canRetryAfterExpiry,
	codexEligibility,
	codexProxyOptions,
	consumeOutcome,
	isAuthExpired,
	isCodexRefusal,
} from "9router-api/domain/codex-reset-credits"
import {
	consumeCodexRateLimitResetCredit,
	getCodexRateLimitResetCredits,
} from "open-sse/services/usage"
import { getProviderConnectionById } from "@/lib/localDb"
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy"
import { refreshAndUpdateCredentials } from "../route.ts"

export const dynamic = "force-dynamic"

/**
 * A connection ready to call upstream, or the response that already answers the caller.
 *
 * One shape for every step that can refuse: the eligibility check, the OAuth refresh, and the
 * handlers all speak this, so a refusal can never be mistaken for a result.
 */
type PreparedConnection =
	| {
			readonly ok: true
			readonly connection: Record<string, unknown>
			readonly isOAuth: boolean
			readonly proxyOptions: Record<string, unknown>
	  }
	| { readonly ok: false; readonly response: Response }

/**
 * A refusal, narrowed.
 *
 * `apps/web` compiles with `strict: false`, where `if (!step.ok)` does not narrow the union above.
 * A type predicate does, and it keeps working unchanged if strict is turned on later.
 */
function isRefused(step: PreparedConnection): step is Extract<PreparedConnection, { ok: false }> {
	return !step.ok
}

/**
 * Resolves the connection and proxy options, or the response that already answers the caller.
 *
 * The eligibility rule lives in `domain/codex-reset-credits.ts`; this does only the I/O around it.
 */
async function resolveCodexConnection(connectionId: unknown): Promise<PreparedConnection> {
	const connection = await getProviderConnectionById(connectionId as string)
	const verdict = codexEligibility(connection)
	if (isCodexRefusal(verdict)) {
		return {
			ok: false,
			response: Response.json({ error: verdict.message }, { status: verdict.status }),
		}
	}
	const proxyOptions = codexProxyOptions(
		await resolveConnectionProxyConfig(connection.providerSpecificData),
	)
	return { ok: true, connection, isOAuth: verdict.isOAuth, proxyOptions }
}

/** The refreshed connection, or the response that answers 401 when the refresh fails. */
async function refreshCodexConnection(
	connection: Record<string, unknown>,
	proxyOptions: Record<string, unknown>,
): Promise<PreparedConnection> {
	try {
		const result = await refreshAndUpdateCredentials(connection, false, proxyOptions)
		return { ok: true, connection: result.connection, isOAuth: true, proxyOptions }
	} catch (refreshError) {
		console.error("[Codex Reset Credits API] Credential refresh failed:", refreshError)
		return {
			ok: false,
			response: Response.json(
				{ error: `Credential refresh failed: ${refreshError.message}` },
				{ status: 401 },
			),
		}
	}
}

/** Refreshes first when the connection is OAuth, so the upstream sees a live credential. */
async function prepareConnection(
	resolved: Extract<PreparedConnection, { ok: true }>,
): Promise<PreparedConnection> {
	if (!resolved.isOAuth) return resolved
	const attempt = await refreshCodexConnection(resolved.connection, resolved.proxyOptions)
	if (isRefused(attempt)) return attempt
	return attempt
}

export async function GET(_request, { params }) {
	let connection
	try {
		const { connectionId } = await params
		const resolved = await resolveCodexConnection(connectionId)
		if (isRefused(resolved)) return resolved.response
		const { isOAuth, proxyOptions } = resolved

		const prepared = await prepareConnection(resolved)
		if (isRefused(prepared)) return prepared.response
		connection = prepared.connection

		let result
		try {
			result = await getCodexRateLimitResetCredits(
				connection.accessToken,
				proxyOptions,
				connection.providerSpecificData,
			)
		} catch (fetchError) {
			// One retry, and only when a refresh token exists to make it worth anything.
			const retryable = canRetryAfterExpiry(
				isOAuth,
				Boolean(connection.refreshToken),
				isAuthExpired(fetchError),
			)
			if (!retryable) throw fetchError
			const retryResult = await refreshAndUpdateCredentials(connection, true, proxyOptions)
			connection = retryResult.connection
			result = await getCodexRateLimitResetCredits(
				connection.accessToken,
				proxyOptions,
				connection.providerSpecificData,
			)
		}

		return Response.json(result)
	} catch (error) {
		const provider = connection?.provider ?? "unknown"
		console.warn(`[Codex Reset Credits] ${provider}: ${error.message}`)
		return Response.json({ error: error.message }, { status: 500 })
	}
}

export async function POST(_request, { params }) {
	let connection
	try {
		const { connectionId } = await params
		const resolved = await resolveCodexConnection(connectionId)
		if (isRefused(resolved)) return resolved.response
		const { isOAuth, proxyOptions } = resolved

		const prepared = await prepareConnection(resolved)
		if (isRefused(prepared)) return prepared.response
		connection = prepared.connection

		// Server-generated redeem id prevents client-controlled replay.
		const redeemRequestId = crypto.randomUUID()
		let consumeResult = await consumeCodexRateLimitResetCredit(
			connection.accessToken,
			redeemRequestId,
			proxyOptions,
		)

		const retryable = canRetryAfterExpiry(
			isOAuth,
			Boolean(connection.refreshToken),
			isAuthExpired(consumeResult),
		)
		if (retryable) {
			try {
				const retryResult = await refreshAndUpdateCredentials(connection, true, proxyOptions)
				connection = retryResult.connection
				consumeResult = await consumeCodexRateLimitResetCredit(
					connection.accessToken,
					redeemRequestId,
					proxyOptions,
				)
			} catch (retryError) {
				// The first result stands: it is still the truthful answer from upstream.
				console.warn(`[Codex Reset Credits] force refresh failed: ${retryError.message}`)
			}
		}

		const outcome = consumeOutcome(consumeResult, redeemRequestId)
		return Response.json(outcome.body, { status: outcome.status })
	} catch (error) {
		const provider = connection?.provider ?? "unknown"
		console.warn(`[Codex Reset Credits] ${provider}: ${error.message}`)
		return Response.json({ error: error.message }, { status: 500 })
	}
}
