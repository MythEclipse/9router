/**
 * Who may spend a Claude "limit reset" grant, and what the answer means.
 *
 * A grant is irreversible: once spent it cannot be given back. That single fact drives every rule
 * here — the eligibility check is strict rather than generous, and an upstream answer this module
 * does not understand is reported as a failure instead of being passed through as if it worked.
 */

/** Claude's provider name, as stored on a connection row. */
export const CLAUDE_PROVIDER = "claude"

/**
 * The only auth type that has grants.
 *
 * An API-key connection has no login session to reset, so offering it the verb would only produce
 * an upstream error the operator cannot act on.
 */
const CLAUDE_AUTH_TYPE = "oauth"

export type ClaudeResetEligibility =
	| {
			readonly ok: true
			readonly connection: Readonly<Record<string, unknown>>
	  }
	| { readonly ok: false; readonly status: number; readonly message: string }

/**
 * Whether this connection can spend a grant.
 *
 * 404 and 400 are deliberately different: a missing row is a routing mistake, while a wrong
 * provider or a key connection is a request this endpoint will never serve. Collapsing them would
 * make a permanent condition look like a transient one.
 */
export function claudeResetEligibility(
	connection: Readonly<Record<string, unknown>> | null | undefined,
): ClaudeResetEligibility {
	if (!connection) {
		return { ok: false, status: 404, message: "Connection not found" }
	}
	if (connection.provider !== CLAUDE_PROVIDER || connection.authType !== CLAUDE_AUTH_TYPE) {
		return {
			ok: false,
			status: 400,
			message: "Limit reset is only available for Claude OAuth connections.",
		}
	}
	return { ok: true, connection }
}

/**
 * What upstream said about the grant.
 *
 * The four named fields are the ones this module reads. The index signature is not laziness: the
 * answer is forwarded to the dashboard whole, so a field upstream adds (a `granted` count, a
 * `credits_left`) must survive the trip rather than being silently dropped by a closed type.
 */
export interface ClaudeResetResult extends Record<string, unknown> {
	readonly ok?: unknown
	readonly status?: unknown
	readonly message?: unknown
	readonly reason?: unknown
	readonly result?: unknown
}

export interface ClaudeResetOutcome {
	readonly status: number
	readonly body: Record<string, unknown>
}

/**
 * The answer to send for an upstream grant result.
 *
 * A `4xx` status is the caller's to fix and is forwarded as it stands. Anything else that is not
 * `ok` becomes a `409`, because "you already spent it" or "there is nothing to spend" is a
 * conflict with the account's current state, not a bad request and not a server fault.
 *
 * A missing message is filled in rather than left empty: the dashboard renders `message`
 * directly, and a blank one shows an operator a dialog with no text.
 */
export function claudeResetOutcome(result: ClaudeResetResult): ClaudeResetOutcome {
	const body = result as Record<string, unknown>
	if (result.ok) return { status: 200, body }

	const status = Number(result.status)
	const forwarded = Number.isFinite(status) && status >= 400 && status < 500 ? status : 409
	const reason = result.reason ?? result.result ?? "unknown"
	return {
		status: forwarded,
		body: { ...body, message: result.message || `Reset not applied: ${String(reason)}` },
	}
}
