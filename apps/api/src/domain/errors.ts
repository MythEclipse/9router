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
	| "CONFLICT"
	| "UPSTREAM"
	| "INTERNAL"

export interface AppErrorOptions {
	/** Machine-readable detail for logs; never rendered to the end user. */
	readonly detail?: string
	readonly cause?: unknown
}

export class AppError extends Error {
	readonly code: AppErrorCode
	readonly detail: string | undefined

	constructor(code: AppErrorCode, message: string, options: AppErrorOptions = {}) {
		super(message, { cause: options.cause })
		this.name = "AppError"
		this.code = code
		this.detail = options.detail
	}
}

export const unauthorized = (message = "Authentication required") =>
	new AppError("UNAUTHORIZED", message)
export const forbidden = (message = "Not permitted") => new AppError("FORBIDDEN", message)
export const notFound = (what: string) => new AppError("NOT_FOUND", `${what} not found`)
export const invalid = (message: string, detail?: string) =>
	new AppError("VALIDATION", message, { detail })
export const conflict = (message: string) => new AppError("CONFLICT", message)
export const upstream = (message: string, cause?: unknown) =>
	new AppError("UPSTREAM", message, { cause })
export const internal = (message: string, cause?: unknown) =>
	new AppError("INTERNAL", message, { cause })
