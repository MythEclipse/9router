/**
 * Maps a use-case refusal onto an HTTP status.
 *
 * Every route used to answer `{error: "Failed to ..."}` with a 500 for anything
 * that threw, so "you sent a bad name" and "the database is gone" looked the same
 * to the dashboard. The use-cases raise typed errors (`AppError` and friends)
 * whose `code` already says which it is; this is the one place that translation
 * happens, instead of each route guessing.
 */
import { NextResponse } from "next/server"

/** How each `AppErrorCode` maps to a status. */
const STATUS_BY_CODE: Record<string, number> = {
	VALIDATION: 400,
	UNAUTHORIZED: 401,
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	CONFLICT: 409,
	/** An upstream dependency refused, which is not this server's fault. */
	UPSTREAM: 503,
}

/** The status a thrown value deserves, defaulting to 500. */
export function statusOf(error: unknown): number {
	if (typeof error !== "object" || error === null) return 500
	const code = (error as { code?: unknown }).code
	if (typeof code !== "string") return 500
	return STATUS_BY_CODE[code] ?? 500
}

/** True when the failure was the caller's, so it should be logged quietly. */
export function isClientError(error: unknown): boolean {
	const status = statusOf(error)
	return status >= 400 && status < 500
}

/**
 * The response for a refused use-case call.
 *
 * The message is passed through because the rules word it for the operator — a
 * generic "Failed to create provider node" tells them nothing about which field
 * was wrong.
 */
export function errorResponse(error: unknown, fallback: string): NextResponse {
	const message = error instanceof Error && error.message ? error.message : fallback
	return NextResponse.json({ error: message }, { status: statusOf(error) })
}

/** Logs a failure only when it is this server's fault, then answers. */
export function failed(error: unknown, fallback: string, context: string): NextResponse {
	if (isClientError(error)) return errorResponse(error, fallback)
	console.error(`[API] ${context}:`, error)
	return errorResponse(error, fallback)
}
