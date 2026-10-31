/**
 * `Idempotency-Key` for the endpoints that cost money.
 *
 * The video endpoints already honoured this header. Everything else — chat completions,
 * embeddings, messages, responses — did not, so a client that timed out *after* the upstream had
 * billed the call and retried was charged twice. The gateway had no way to tell the two requests
 * apart: the `requestId` dedupe in `usageRepo` protects the usage row, not the upstream call.
 *
 * Three rules, and they are the whole reason this is a wrapper rather than a few lines inside
 * each handler:
 *
 * 1. **The body is read from a clone.** The handler must still be able to read the request, and
 *    a consumed body is a 400 the client cannot debug. Cloning costs one copy of a payload that
 *    is already in memory.
 * 2. **A claim is taken before the call, released on failure.** Without the claim, two
 *    concurrent retries both see "nothing stored" and both run. With it, the second is told 409
 *    and to retry shortly — the same answer every implementation of this header gives.
 * 3. **Only a JSON answer is stored.** A streamed body is a wire format, not a document, and a
 *    5xx is an attempt that should be retried rather than replayed. Both cases release the claim
 *    so the retry runs for real.
 *
 * The key is namespaced by the presented credential and the path, so one tenant's `abc-123`
 * cannot read another's answer and the same key used on two endpoints does not collide.
 */
import { createHash } from "node:crypto"
import {
	IDEMPOTENCY_TTL_MS,
	isIdempotencyKeyRefused,
	isReplayableResponse,
	resolveIdempotencyKey,
} from "9router-api/domain/idempotency"

/** A hash of anything, hex. Used for the fingerprint and the namespaced key. */
function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex")
}

/** The credential the caller presented, reduced to something that cannot be replayed. */
function credentialOf(request: Request): string {
	const authorization = request.headers.get("authorization") ?? ""
	const apiKey = request.headers.get("x-api-key") ?? ""
	const token = request.headers.get("x-goog-api-key") ?? ""
	return sha256(`${authorization}\u0000${apiKey}\u0000${token}`)
}

function jsonError(status: number, message: string, extraHeaders: Record<string, string> = {}) {
	return new Response(JSON.stringify({ error: { message, type: "idempotency_error" } }), {
		status,
		headers: { "Content-Type": "application/json", ...extraHeaders },
	})
}

/**
 * Run `handler` under the key's protection, or replay the answer the key already produced.
 *
 * A request without the header takes the handler directly: this must be invisible to the clients
 * that never asked for it.
 */
export async function withIdempotency(
	request: Request,
	handler: () => Promise<Response>,
): Promise<Response> {
	const rawKey = request.headers.get("idempotency-key")
	if (rawKey === null) return handler()

	const validated = resolveIdempotencyKey(rawKey)
	if (isIdempotencyKeyRefused(validated)) return jsonError(400, validated.message)

	// Read the body from a clone: the handler still owns the original.
	let bodyText = ""
	try {
		bodyText = await request.clone().text()
	} catch {
		// An unreadable body cannot be fingerprinted, so the request is passed through rather
		// than refused — the handler will produce the real error for it.
		return handler()
	}

	const namespaced = sha256(
		`${credentialOf(request)}\u0000${new URL(request.url).pathname}\u0000${validated.key}`,
	)
	const fingerprint = sha256(bodyText)
	// Imported on the key path only: a request without the header never loads the use-case graph,
	// and a module that mentions this route does not open the database.
	const idempotency = await idempotencyUseCase()
	if (!idempotency) return handler()

	let claim
	try {
		claim = await idempotency.begin(namespaced, fingerprint)
	} catch {
		// A store that cannot be read must not block a request: the client asked for an answer,
		// not for a guarantee, and the guarantee is what failed.
		return handler()
	}

	if (claim.verdict === "replay" && claim.replay) {
		return new Response(claim.replay.body, {
			status: claim.replay.status,
			headers: {
				"Content-Type": claim.replay.contentType ?? "application/json",
				"X-9Router-Idempotent-Replay": "true",
			},
		})
	}
	if (claim.verdict === "conflict") {
		return jsonError(409, "This Idempotency-Key was already used with a different request body")
	}
	if (claim.verdict === "in_progress") {
		return jsonError(409, "A request with this Idempotency-Key is still running", {
			"Retry-After": "1",
		})
	}

	let response: Response
	try {
		response = await handler()
	} catch (error) {
		// The call did not finish, so the key must be free for the retry.
		await idempotency.abandon(namespaced)
		throw error
	}

	const contentType = response.headers.get("content-type")
	const storeable =
		(contentType ?? "").toLowerCase().includes("application/json") &&
		isReplayableResponse({ status: response.status, contentType })

	if (!storeable) {
		await idempotency.abandon(namespaced)
		return response
	}

	try {
		await idempotency.finish(namespaced, {
			status: response.status,
			contentType,
			body: await response.clone().text(),
		})
	} catch {
		// The answer is already on its way to the client; a failed store only means the next
		// retry runs again.
		await idempotency.abandon(namespaced)
	}
	return response
}

/**
 * The idempotency use-case, or `null` when the graph could not be built.
 *
 * Passing the request through unprotected is the lesser failure: a client that sends the header
 * still gets its answer, and the alternative is that every completion fails with a 500 about a
 * table the caller cannot see. Logged once, because a silently unprotected gateway is a real
 * problem that should not be discovered from a bill.
 */
let graphFailureLogged = false

async function idempotencyUseCase() {
	try {
		const { getUseCases } = await import("@/lib/useCases")
		return getUseCases().idempotency
	} catch (error) {
		if (!graphFailureLogged) {
			graphFailureLogged = true
			console.error(
				"[idempotency] use-case graph unavailable; Idempotency-Key is ignored:",
				error instanceof Error ? error.message : error,
			)
		}
		return null
	}
}

/** How long a stored answer stays replayable, for the dashboard's documentation. */
export const IDEMPOTENCY_WINDOW_MS = IDEMPOTENCY_TTL_MS
