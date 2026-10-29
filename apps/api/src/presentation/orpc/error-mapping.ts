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
 * Convert anything thrown by a use-case into an `ORPCError`.
 *
 * An unrecognised throw is reported as INTERNAL with a generic message: an
 * unexpected error message can carry a database path or a token, and the
 * client has no business seeing either. The original stays in `cause` for the
 * server-side log.
 */
export function toORPCError(error: unknown): ORPCError<string, unknown> {
	if (error instanceof AppError) {
		return new ORPCError(error.code, {
			status: statusFor(error.code),
			message: error.message,
			cause: error,
			data: error.detail ? { detail: error.detail } : undefined,
		})
	}
	return new ORPCError("INTERNAL", {
		status: 500,
		message: "Internal server error",
		cause: error,
	})
}
