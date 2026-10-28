/**
 * Claude Code auto-mode safeguard protocol.
 *
 * 9router is a gateway, so Claude Code treats it as "the Anthropic API". That
 * makes 9router responsible for BOTH halves of the auto-mode contract:
 *
 *   1. Pass-through (preferred): forward the `safeguards` request field and the
 *      `dangerous-tool-use-*` beta to an upstream that implements them, and relay
 *      `safeguard_results` back byte-for-byte. The upstream's verdicts decide.
 *
 *   2. Bridged: when the upstream is a decision model (System One / TypeSafe
 *      "Jev" lanes), that upstream cannot run server-side review, so 9router
 *      runs the review itself with the System One engine and synthesizes the
 *      `safeguard_results` the client expects.
 *
 * The bridge maps a System One probability onto the client's verdict vocabulary
 * (flagged / not_flagged) and correlates it BY tool_use.id, because the client
 * discards any result it cannot key to a call in the response.
 *
 * IMPORTANT: no verdict is a denial, not a bypass. When the decision engine
 * cannot answer, we emit `unsupported`/`unavailable` so Claude Code falls back to
 * its own (billed) classifier. Silently emitting "not_flagged" on an engine
 * failure would disable the safety review entirely.
 */

import {
	DANGEROUS_TOOL_USE_BETA,
	OUTCOME_FLAGGED,
	OUTCOME_NOT_FLAGGED,
	SAFEGUARD_RESULTS_RESPONSE_FIELD,
	SAFEGUARD_STATUS_AVAILABLE,
	SAFEGUARD_STATUS_UNAVAILABLE,
	SAFEGUARD_STATUS_UNSUPPORTED,
	SAFEGUARD_TYPE_DANGEROUS_TOOL_USE,
	SAFEGUARDS_REQUEST_FIELD,
	VERDICT_TYPE_EVALUATED,
} from "../config/safeguardsConstants.ts"

// Probability at or above which a System One decision is treated as a block.
// Jev emits { type: "noul", noul: <p> } where p is the probability that the
// action is NOT safe, so this is a "flagged when confidence is this high" gate.
// Kept as a named constant because it is a policy choice, not a wire format.
export const DEFAULT_FLAG_THRESHOLD = 0.5

/**
 * Whether a request asks the server to review dangerous tool uses.
 *
 * Detected from the body alone (the `safeguards` field is unambiguous), so this
 * stays correct even when the beta header was rewritten upstream.
 *
 * @param {object} body - Claude-format request body
 * @returns {boolean}
 */
export function hasSafeguardsRequest(body) {
	const entries = body?.[SAFEGUARDS_REQUEST_FIELD]
	return Array.isArray(entries) && entries.some((e) => e?.type === SAFEGUARD_TYPE_DANGEROUS_TOOL_USE)
}

/**
 * The classifier_context Claude Code sent, when present.
 * @param {object} body
 * @returns {object|null}
 */
export function getClassifierContext(body) {
	const entry = (body?.[SAFEGUARDS_REQUEST_FIELD] || []).find(
		(e) => e?.type === SAFEGUARD_TYPE_DANGEROUS_TOOL_USE,
	)
	return entry?.classifier_context ?? null
}

/**
 * Whether the client paired the safeguards field with its beta header.
 * Used only for diagnostics — we forward the field either way, because dropping
 * one half of the pair is what produces the hard 400.
 *
 * @param {object} rawHeaders - incoming client headers
 * @returns {boolean}
 */
export function hasSafeguardsBetaHeader(rawHeaders) {
	const raw = rawHeaders?.["anthropic-beta"] ?? rawHeaders?.["Anthropic-Beta"]
	if (typeof raw !== "string") return false
	return raw.split(",").some((v) => v.trim() === DANGEROUS_TOOL_USE_BETA)
}

/**
 * Ids of the tool_use blocks in a Claude response body, in wire order.
 * The verdict map must be keyed by exactly these ids or the client ignores it.
 *
 * @param {object} responseBody
 * @returns {string[]}
 */
export function collectToolUseIds(responseBody) {
	const ids = []
	for (const block of responseBody?.content || []) {
		if (block?.type === "tool_use" && typeof block.id === "string" && block.id) ids.push(block.id)
	}
	return ids
}

/** One verdict for a reviewed tool call, keyed by tool_use.id. */
export interface SafeguardToolVerdict {
	type: string
	outcome?: string
	explanation?: string
}

/** `safeguard_results[].status` — either a verdict map or an unavailable marker. */
export interface SafeguardStatus {
	type: string
	reason?: string
	tool_uses?: Record<string, SafeguardToolVerdict>
}

/** One `safeguard_results` entry relayed to the client. */
export interface SafeguardResult {
	type: string
	status: SafeguardStatus
}

/**
 * A `status` object marking the server does not run server-side review.
 * Tells the client to use its own classifier rather than reading a verdict.
 *
 * @param {string} type - "unsupported" | "unavailable"
 * @param {string} [reason]
 */
export function buildUnavailableStatus(
	type = SAFEGUARD_STATUS_UNSUPPORTED,
	reason,
): SafeguardStatus {
	return type === SAFEGUARD_STATUS_UNAVAILABLE
		? { type: SAFEGUARD_STATUS_UNAVAILABLE, reason }
		: { type: SAFEGUARD_STATUS_UNSUPPORTED }
}

/**
 * Full `safeguard_results` payload with no verdicts.
 * @param {string} [type]
 * @param {string} [reason]
 */
export function buildUnavailableResults(
	type = SAFEGUARD_STATUS_UNSUPPORTED,
	reason,
): SafeguardResult[] {
	return [{ type: SAFEGUARD_TYPE_DANGEROUS_TOOL_USE, status: buildUnavailableStatus(type, reason) }]
}

/**
 * Build the `safeguard_results` array the client expects.
 *
 * @param {object} params
 * @param {string[]} params.toolUseIds - ids to key verdicts by
 * @param {boolean} params.flagged - whether the action is a safety violation
 * @param {string} [params.explanation] - rule name, shown to the user on a block
 * @param {number} [params.threshold] - System One probability gate
 * @returns {object[]} The `safeguard_results` array
 */
export function buildSafeguardResults({
	toolUseIds,
	flagged,
	explanation,
	threshold = DEFAULT_FLAG_THRESHOLD,
}): SafeguardResult[] {
	if (!Array.isArray(toolUseIds) || toolUseIds.length === 0) {
		// No call to judge: report review as available with an empty map rather
		// than unavailable, so the client is not told the server lacks review.
		return [
			{
				type: SAFEGUARD_TYPE_DANGEROUS_TOOL_USE,
				status: { type: SAFEGUARD_STATUS_AVAILABLE, tool_uses: {} },
			},
		]
	}

	const toolUses: Record<string, SafeguardToolVerdict> = {}
	for (const id of toolUseIds) {
		toolUses[id] = {
			type: VERDICT_TYPE_EVALUATED,
			outcome: flagged ? OUTCOME_FLAGGED : OUTCOME_NOT_FLAGGED,
			...(flagged && explanation ? { explanation } : {}),
		}
	}

	return [
		{
			type: SAFEGUARD_TYPE_DANGEROUS_TOOL_USE,
			status: { type: SAFEGUARD_STATUS_AVAILABLE, tool_uses: toolUses },
		},
	]
}

/**
 * Read a System One / TypeSafe decision answer as a 0..1 "unsafe" probability.
 *
 * Upstream shape (verified live against openrouter/typesafe/jev-1.13):
 *   { answers: { <questionKey>: { type: "noul", noul: 0.66 } } }
 *
 * Providers vary the key and may nest or invert the number, so this accepts a
 * single-answer object of any key. Returns null when nothing usable is present,
 * which the caller must treat as "no verdict" — never as "safe".
 *
 * @param {object} systemoneResponse
 * @returns {number|null}
 */
export function readSystemoneProbability(systemoneResponse) {
	const answers = systemoneResponse?.answers
	if (!answers || typeof answers !== "object") return null

	for (const answer of Object.values(answers) as Record<string, unknown>[]) {
		if (!answer || typeof answer !== "object") continue
		const record = answer as Record<string, unknown>
		// Preferred: the documented { type: "noul", noul } pair.
		if (typeof record.noul === "number" && Number.isFinite(record.noul)) return record.noul
		// Tolerated aliases across decision providers.
		for (const key of ["probability", "score", "value", "confidence"]) {
			if (typeof record[key] === "number" && Number.isFinite(record[key])) return record[key] as number
		}
	}
	return null
}

/**
 * Turn a System One decision into a client verdict.
 *
 * `null` probability means the engine did not answer; we deliberately produce
 * "unavailable" so Claude Code falls back to its own classifier instead of
 * treating an engine failure as approval.
 *
 * @param {object} params
 * @param {object|null} params.systemoneResponse
 * @param {string[]} params.toolUseIds
 * @param {number} [params.threshold]
 * @param {string} [params.explanation]
 * @returns {object[]} `safeguard_results`
 */
export function buildSafeguardResultsFromDecision({
	systemoneResponse,
	toolUseIds,
	threshold = DEFAULT_FLAG_THRESHOLD,
	explanation,
}) {
	const probability = readSystemoneProbability(systemoneResponse)
	if (probability === null) {
		return buildUnavailableResults(
			SAFEGUARD_STATUS_UNAVAILABLE,
			"decision engine returned no usable answer",
		)
	}
	const flagged = probability >= threshold
	return buildSafeguardResults({
		toolUseIds,
		flagged,
		explanation: flagged ? explanation : undefined,
	})
}

/**
 * Attach verdicts to a non-streaming Claude response body.
 * Mutates and returns the body — callers already own the parsed object.
 *
 * @param {object} responseBody
 * @param {object[]} safeguardResults
 * @returns {object} the same body
 */
export function attachSafeguardResults(responseBody, safeguardResults) {
	if (!responseBody || typeof responseBody !== "object" || !Array.isArray(safeguardResults))
		return responseBody
	if (!Array.isArray(responseBody.content)) return responseBody
	responseBody[SAFEGUARD_RESULTS_RESPONSE_FIELD] = safeguardResults
	return responseBody
}

/**
 * Render the SSE bytes for a `message_delta` event carrying verdicts.
 * Claude Code reads `safeguard_results` from the FINAL message_delta's delta.
 *
 * @param {object} params
 * @param {object[]} params.safeguardResults
 * @param {object} [params.delta] - extra delta fields to merge (stop_reason etc.)
 * @param {object} [params.message] - message fields used by the final event
 * @returns {string} SSE frame
 */
export function buildSafeguardMessageDeltaSse({
	safeguardResults,
	delta = undefined,
	message = undefined,
}: {
	safeguardResults: SafeguardResult[]
	delta?: Record<string, unknown> | null
	message?: Record<string, unknown> | null
}) {
	const payload = {
		type: "message_delta",
		delta: { ...(delta || {}), [SAFEGUARD_RESULTS_RESPONSE_FIELD]: safeguardResults },
		...(message ? { message } : {}),
	}
	return `event: message_delta\ndata: ${JSON.stringify(payload)}\n\n`
}
