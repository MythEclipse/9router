/**
 * Domain error → transport error mapping.
 *
 * Only this file knows both vocabularies. Keeping it in one place means adding
 * a new `AppErrorCode` is a single edit, and no use-case has to know what an
 * HTTP status is.
 */
import { ORPCError } from "@orpc/server"
import { AppError, type AppErrorCode } from "../../domain/errors.ts"

const STATUS_BY_CODE: Record<AppErrorCode, number> = {
	UNAUTHORIZED: 401,
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	VALIDATION: 400,
	PAYLOAD_TOO_LARGE: 413,
	CONFLICT: 409,
	UPSTREAM: 502,
	INTERNAL: 500,
}

export function statusFor(code: AppErrorCode): number {
	return STATUS_BY_CODE[code]
}

/**
 * Whether this throw is an `AppError`, without asking `instanceof`.
 *
 * `instanceof` is unreliable here: the dashboard loads `apps/api` through Next's
 * transpile pipeline, and `domain/errors.ts` ends up evaluated once for the router chunk
 * and once for the route chunk. Both copies produce structurally identical errors, but a
 * class check across them answers `false` and every `NOT_FOUND`, `VALIDATION` or
 * `CONFLICT` collapses into a bare 500 — which is exactly what a live probe of
 * `/api/providers/nope/test` showed while the unit tests were green.
 *
 * The shape is checked instead: a `code` this vocabulary defines. It cannot be forged by
 * an arbitrary throw into a client-visible status unless the throw already names one of
 * our codes, and an error that does is indistinguishable from the real thing by design.
 */
function appErrorOf(error: unknown): AppError | null {
	if (error instanceof AppError) return error
	if (typeof error !== "object" || error === null) return null
	const code = (error as { code?: unknown }).code
	if (typeof code !== "string" || !(code in STATUS_BY_CODE)) return null
	const message = (error as { message?: unknown }).message
	if (typeof message !== "string") return null
	return error as AppError
}

/**
 * Convert anything thrown by a use-case into an `ORPCError`.
 *
 * An unrecognised throw is reported as INTERNAL with a generic message: an
 * unexpected error message can carry a database path or a token, and the
 * client has no business seeing either. The original stays in `cause` for the
 * server-side log.
 */
export function toORPCError(error: unknown): ORPCError<string, unknown> {
	const appError = appErrorOf(error)
	if (appError) {
		return new ORPCError(appError.code, {
			// A carried status wins: the provider already said 429, and reporting 502
			// because UPSTREAM maps there would throw away the one fact that tells the
			// operator to retry later rather than call support.
			status: appError.status ?? statusFor(appError.code),
			message: appError.message,
			cause: appError,
			// `detail` is for the log; `data` is what a client acts on, so the two are
			// carried separately and a structured conflict reaches the dashboard intact.
			data: appError.data ?? (appError.detail ? { detail: appError.detail } : undefined),
		})
	}
	return new ORPCError("INTERNAL", {
		status: 500,
		message: "Internal server error",
		cause: error,
	})
}
