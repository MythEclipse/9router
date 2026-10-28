/**
 * Claude Code auto-mode (dangerous_tool_use) safeguard protocol constants.
 *
 * Wire shapes verified against the installed Claude Code client (v2.1.296)
 * rather than documentation, because Anthropic publishes no schema page for
 * this pairing and gateways that guess it break the beta/field contract.
 *
 * The contract is a pair that must travel together (per Anthropic's gateway
 * compatibility guide):
 *   request  : `anthropic-beta: dangerous-tool-use-<date>` + top-level
 *              `safeguards: [{ type, classifier_context }]`
 *   response : top-level `safeguard_results: [{ type, status }]`
 *
 * Forwarding one half without the other is a hard 400 from the Anthropic API
 * and, once latched by the client, disables auto mode for the whole session.
 */

// The server-side review pairing. Must be forwarded verbatim; Claude Code
// unions it into its own anthropic-beta header on eligible sessions.
export const DANGEROUS_TOOL_USE_BETA = "dangerous-tool-use-2026-09-03"

// The sibling beta on Claude Code's OWN classifier requests (the billed
// fallback path). Recognized here so the flag is not mistaken for the
// server-side pairing when classifying a request.
export const AUTO_MODE_CLASSIFIER_BETA = "auto-mode-classifier-2026-07-16"

// `safeguards[]` entry type. Claude Code tolerates exactly one entry of this
// type per response; two or more make it ignore the whole result.
export const SAFEGUARD_TYPE_DANGEROUS_TOOL_USE = "dangerous_tool_use"

// `status.type` values the client parses.
export const SAFEGUARD_STATUS_AVAILABLE = "available"
export const SAFEGUARD_STATUS_UNSUPPORTED = "unsupported"
export const SAFEGUARD_STATUS_UNAVAILABLE = "unavailable"

// Per-tool verdict values.
export const OUTCOME_FLAGGED = "flagged"
export const OUTCOME_NOT_FLAGGED = "not_flagged"

export const VERDICT_TYPE_EVALUATED = "evaluated"
export const VERDICT_TYPE_SKIPPED = "skipped"
export const VERDICT_TYPE_UNAVAILABLE = "unavailable"

// Both sides of the pair. Used to detect a server-side review request without
// trusting either half alone.
export const SAFEGUARDS_REQUEST_FIELD = "safeguards"
export const SAFEGUARD_RESULTS_RESPONSE_FIELD = "safeguard_results"

// Claude's own classifier requests are ordinary /v1/messages calls tagged with
// this query source. They are routed like any other turn — the difference is
// that 9router answers them with a decision, not prose.
export const AUTO_MODE_QUERY_SOURCE = "auto_mode"
