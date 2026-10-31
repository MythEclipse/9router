/**
 * Idempotent retries: one `Idempotency-Key` means one billed call.
 *
 * Every other endpoint in this gateway is safe to retry because a retry costs nothing but
 * time. A completion does not: a client that times out after the upstream has already been
 * billed and retries will be billed twice, and the gateway has no way to know the two requests
 * were the same one. The video endpoints learned this first (`idempotencyKey` on the request
 * body); this module is the same rule for everything that answers with JSON.
 *
 * Four rules, each one a way this goes wrong:
 *
 * 1. **The key alone is not the identity.** Two different bodies sent under one key is a
 *    client bug, and answering the first response to the second request would hand back an
 *    answer to a question nobody asked. Same key + different fingerprint is a 409, never a
 *    replay.
 * 2. **A key belongs to its caller and its endpoint.** The key is namespaced by the presented
 *    credential and the path, so one tenant's `abc-123` cannot read another's response, and a
 *    key reused across `/v1/embeddings` and `/v1/chat/completions` does not collide.
 * 3. **A second request arriving while the first is in flight is refused, not run.** Two
 *    concurrent executions of one key is exactly the double-charge the header exists to
 *    prevent, and "wait for it" is not available inside a stateless request. The caller gets
 *    409 plus a `Retry-After`, which is what every implementation of this header does.
 * 4. **A streamed answer is not replayable here.** The stored value is a body, and a body that
 *    was an event stream cannot be re-sent as a stream. A streamed request is passed straight
 *    through and its marker is cleared, so a retry re-runs rather than replaying half a
 *    response. That is a real limitation, stated rather than hidden.
 */

/** How long a completed response stays replayable. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000

/** The longest key a client may send. Long enough for a UUID pair, short enough to index. */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255

/** What the stored row says about a key. */
export type IdempotencyState = "in_progress" | "done"

/** The verdict for an incoming request. */
export type IdempotencyVerdict = "fresh" | "replay" | "conflict" | "in_progress"

export interface IdempotencyRecord {
	readonly state: IdempotencyState
	/** Hash of the request body the stored answer belongs to. */
	readonly fingerprint: string
	readonly status: number | null
	readonly contentType: string | null
	readonly body: string | null
	readonly expiresAt: number
}

export type IdempotencyKeyResult =
	| { readonly ok: true; readonly key: string }
	| { readonly ok: false; readonly message: string }

/**
 * Narrows a key answer to its refusal branch.
 *
 * A predicate rather than `if (!result.ok)`, because `apps/web` compiles with `strict: false`
 * and a discriminated union does not narrow through a boolean discriminant there.
 */
export function isIdempotencyKeyRefused(
	result: IdempotencyKeyResult,
): result is { readonly ok: false; readonly message: string } {
	return !result.ok
}

/**
 * Validate a client-supplied key.
 *
 * Whitespace is refused rather than trimmed: a key with a trailing space in one client and not
 * the other is two keys, and the client that "fixed" it would silently start double-charging.
 * Anything unprintable is refused for the same reason — it cannot survive a header round-trip
 * unchanged.
 */
export function resolveIdempotencyKey(raw: unknown): IdempotencyKeyResult {
	if (raw === undefined || raw === null) return { ok: false, message: "Missing Idempotency-Key" }
	if (typeof raw !== "string") return { ok: false, message: "Idempotency-Key must be a string" }
	const key = raw
	if (key.length === 0) return { ok: false, message: "Idempotency-Key must not be empty" }
	if (key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
		return {
			ok: false,
			message: `Idempotency-Key must be at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
		}
	}
	if (!/^[\x21-\x7e]+$/.test(key)) {
		return { ok: false, message: "Idempotency-Key must be printable ASCII without spaces" }
	}
	return { ok: true, key }
}

/**
 * What to do with an incoming request, given what is stored for its key.
 *
 * `null` means nothing is stored — or what was stored has expired, which is the same thing to
 * the caller: the window in which a replay was possible has closed.
 */
export function idempotencyVerdict(
	stored: IdempotencyRecord | null,
	incomingFingerprint: string,
	now = Date.now(),
): IdempotencyVerdict {
	if (!stored) return "fresh"
	if (stored.expiresAt <= now) return "fresh"
	if (stored.fingerprint !== incomingFingerprint) return "conflict"
	if (stored.state === "in_progress") return "in_progress"
	return "replay"
}

/**
 * Whether a response may be stored for replay.
 *
 * Two refusals: a streamed body (it is a wire format, not a document) and any 5xx (a failed
 * attempt must not become the answer for the next day — the retry is supposed to succeed).
 * A 4xx is stored on purpose: a client that retries a rejected request should get the same
 * rejection rather than a second upstream call.
 */
export function isReplayableResponse(input: {
	readonly status: number
	readonly contentType: string | null
}): boolean {
	if (input.status >= 500) return false
	const contentType = (input.contentType ?? "").toLowerCase()
	return !contentType.includes("text/event-stream")
}
