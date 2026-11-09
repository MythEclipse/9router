/** chatCore helpers. */

/**
 * Remove translator-internal continuity fields from the outbound upstream
 * body. The Responses→Chat request translator stashes reasoning
 * `encrypted_content` on assistant messages so a later openai→responses
 * round-trip can restore the store=false continuity blob; that stash must
 * never reach an upstream provider. Chat-native proxies reject the unknown
 * assistant-message field and answer every turn with a literal "400" body
 * (observed with multi-turn Codex sessions via OpenAI-compatible nodes).
 */
export function stripContinuityFields(body) {
	if (!body || !Array.isArray(body.messages)) return body
	for (const msg of body.messages) {
		if (msg && typeof msg === "object") {
			delete msg.encrypted_content
			delete msg.reasoning_encrypted_content
		}
	}
	return body
}

export async function logInvalidCodexUpstream({
	provider,
	model,
	providerResponse,
	rawText,
	statusCode,
	reqTag,
	log,
}) {
	if (provider !== "codex") return
	const contentType = providerResponse?.headers?.get?.("content-type") || "unknown"
	const text = String(rawText || "")
		.replace(/\s+/g, " ")
		.trim()
	const snippet = text ? text.slice(0, 1200) : "<empty>"
	const msg = `codex upstream invalid JSON | status=${statusCode} | content-type=${contentType} | snippet=${snippet}`
	console.error(`[${reqTag || "codex"}] ${msg}`)
	log?.errorLine?.(
		reqTag,
		"✗",
		`UPSTREAM BAD_GATEWAY · ${provider}/${model} · invalid JSON response\n    status=${statusCode}\n    content-type=${contentType}\n    snippet=${snippet}`,
	)
}

/** Length of a request-side array field without committing to its element type. */
export function countOf(value: unknown): number {
	return Array.isArray(value) ? value.length : 0
}

export function isTokenExpiringSoon(expiresAt, bufferMs = 5 * 60 * 1000) {
	if (!expiresAt) return false
	return new Date(expiresAt).getTime() - Date.now() < bufferMs
}
