/**
 * Who a memory belongs to, inside one shared bank.
 *
 * The bank is a single physical store, so isolation cannot come from bank
 * separation. It comes from the tag the **gateway** stamps on every retain, and
 * the tag it filters recall with. The caller never supplies either: a client that
 * could choose its own tag could write into another principal's scope, which is
 * the whole channel this module exists to close.
 *
 * The tag carries a hash, never the API key itself, so a leaked log line or a
 * recalled memory's `tags` array never yields a usable credential.
 */

import crypto from "node:crypto"

/** Prefix for every tag this build writes, so an operator can find them all. */
const TAG_PREFIX = "principal:"

/**
 * Scope for callers that present no API key (local mode, `requireApiKey` off).
 *
 * Deliberately one shared anonymous scope rather than "untagged": untagged is the
 * shared/global scope, and letting anonymous callers write there would make every
 * public request a write into the knowledge everyone reads.
 */
export const ANONYMOUS_PRINCIPAL = "anonymous"

/**
 * The recall/retain tag for a request, derived from its API key.
 *
 * @param apiKey the client key as extracted by `extractApiKey`, or null
 */
export function principalTag(apiKey: string | null | undefined): string {
	return `${TAG_PREFIX}${principalHash(apiKey)}`
}

/** The stable, non-reversible identifier behind the tag. */
export function principalHash(apiKey: string | null | undefined): string {
	const key = typeof apiKey === "string" ? apiKey.trim() : ""
	if (!key) return ANONYMOUS_PRINCIPAL
	return crypto.createHash("sha256").update(key).digest("hex").slice(0, 32)
}

/**
 * The document id one conversation's retained transcript lives under.
 *
 * Scoped by principal as well as session: two callers that happen to present the
 * same session id must not upsert each other's document, because `update_mode:
 * "append"` writes into whatever document the id names.
 */
export function memoryDocumentId(sessionId: string, apiKey: string | null | undefined): string {
	const session = typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : "no-session"
	return `chat-${principalHash(apiKey)}-${shortHash(session)}`
}

function shortHash(value: string): string {
	return crypto.createHash("sha256").update(value).digest("hex").slice(0, 24)
}
