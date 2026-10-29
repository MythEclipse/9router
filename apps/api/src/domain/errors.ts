/**
 * Typed application errors.
 *
 * Domain and application code throws these; only the presentation layer turns
 * them into transport responses. Nothing below presentation imports Hono, oRPC
 * or Drizzle, so the layers stay swappable and independently testable.
 */

export type AppErrorCode =
	| "UNAUTHORIZED"
	| "FORBIDDEN"
	| "NOT_FOUND"
	| "VALIDATION"
	| "PAYLOAD_TOO_LARGE"
	| "CONFLICT"
	| "UPSTREAM"
	| "INTERNAL"

export interface AppErrorOptions {
	/** Machine-readable detail for logs; never rendered to the end user. */
	readonly detail?: string
	readonly cause?: unknown
	/** Structured facts a client needs to act on — e.g. which row holds a name. */
	readonly data?: Record<string, unknown>
	/**
	 * Carried HTTP status, when the failure came from somewhere that already decided one.
	 *
	 * A provider that answers 429 while we list its models must reach the dashboard as a
	 * 429 — "try again later" — not as a 500, and not as whatever `code` would imply. The
	 * code still describes the *kind* of failure; this describes the number the caller saw.
	 */
	readonly status?: number
}

export class AppError extends Error {
	readonly code: AppErrorCode
	readonly detail: string | undefined
	readonly data: Record<string, unknown> | undefined
	readonly status: number | undefined

	constructor(code: AppErrorCode, message: string, options: AppErrorOptions = {}) {
		super(message, { cause: options.cause })
		this.name = "AppError"
		this.code = code
		this.detail = options.detail
		this.data = options.data
		this.status = options.status
	}
}

export const unauthorized = (message = "Authentication required") =>
	new AppError("UNAUTHORIZED", message)
export const forbidden = (message = "Not permitted") => new AppError("FORBIDDEN", message)
export const notFound = (what: string) => new AppError("NOT_FOUND", `${what} not found`)
export const invalid = (message: string, detail?: string) =>
	new AppError("VALIDATION", message, { detail })
export const conflict = (message: string, data?: Record<string, unknown>) =>
	new AppError("CONFLICT", message, { data })
export const tooLarge = (message = "Payload too large") =>
	new AppError("PAYLOAD_TOO_LARGE", message)
export const upstream = (message: string, cause?: unknown) =>
	new AppError("UPSTREAM", message, { cause })
export const internal = (message: string, cause?: unknown) =>
	new AppError("INTERNAL", message, { cause })
