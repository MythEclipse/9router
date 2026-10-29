/**
 * Importing a Kiro CLIProxyAPI auth file is a single create call wrapped in a body-shape guess. The
 * guess is the rule, and it has a failure mode worth naming.
 *
 * - **The payload may arrive under three different keys.** CLIProxyAPI exports wrap the auth blob as
 *   `cliProxyAuth`, some callers send `auth`, some send `json`, and hand-written callers post the
 *   blob itself. All four are the same import; only the envelope differs.
 * - **A body with no wrapper key is passed through as-is.** This is what makes the raw form work,
 *   but it also means a malformed body reaches the normaliser instead of being rejected here. That
 *   is deliberate: the normaliser is the component that knows which fields are required, and it
 *   answers with the sentence that names the missing one.
 * - **Every refusal is a 400, and the normaliser's message is the answer.** The user pasted a file;
 *   "token_endpoint must be a Microsoft login endpoint" is actionable in a way "import failed" is
 *   not, so the message is forwarded rather than replaced.
 */

/** Which key the auth blob arrived under, or the blob itself when it arrived bare. */
export function kiroImportPayload(body: unknown): unknown {
	if (typeof body !== "object" || body === null) return body
	const envelope = body as Record<string, unknown>
	return envelope.cliProxyAuth ?? envelope.auth ?? envelope.json ?? body
}

/** The status for an import that threw: the payload was bad, so the request was bad. */
export const KIRO_IMPORT_REFUSAL_STATUS = 400
const KIRO_IMPORT_FALLBACK_MESSAGE = "CLIProxyAPI import failed"

/**
 * The message to send back for a refused import.
 *
 * Errors from `normalizeKiroExternalIdpAuth` carry the field name; anything else (a thrown string, a
 * `null`) gets the generic sentence rather than `undefined` rendered into the response.
 */
export function kiroImportRefusalMessage(error: unknown): string {
	if (error instanceof Error && error.message) return error.message
	if (typeof error === "string" && error) return error
	return KIRO_IMPORT_FALLBACK_MESSAGE
}

/**
 * The connection summary echoed back after a successful import.
 *
 * Only three fields: the dashboard needs to confirm *which* account landed. The tokens that were
 * just stored are not echoed — an import response is the last place a refresh token should appear.
 */
export function kiroImportSummary(connection: {
	readonly id: unknown
	readonly provider?: unknown
	readonly email?: unknown
}): { success: true; connection: { id: unknown; provider: unknown; email: unknown } } {
	return {
		success: true,
		connection: {
			id: connection.id,
			provider: connection.provider,
			email: connection.email,
		},
	}
}
