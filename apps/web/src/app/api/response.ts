/**
 * Use-case error → HTTP response.
 *
 * The use-cases throw `AppError` with a code; only this file knows what status
 * each code means. Keeping it here means a new route does not have to remember
 * that VALIDATION is 400 — and cannot disagree with the others about it.
 */
import { NextResponse } from "next/server"

export function toResponse(error: unknown): NextResponse {
	const code = (error as { code?: string } | null)?.code
	const message = error instanceof Error ? error.message : "Request failed"

	if (code === "VALIDATION") return NextResponse.json({ error: message }, { status: 400 })
	if (code === "UNAUTHORIZED") return NextResponse.json({ error: message }, { status: 401 })
	if (code === "FORBIDDEN") return NextResponse.json({ error: message }, { status: 403 })
	if (code === "NOT_FOUND") return NextResponse.json({ error: message }, { status: 404 })
	if (code === "CONFLICT") return NextResponse.json({ error: message }, { status: 409 })
	if (code === "UPSTREAM") return NextResponse.json({ error: message }, { status: 502 })

	// An unrecognised throw may carry a database path or a token; the client gets
	// a generic message and the detail stays in the server log.
	console.log("route error:", error)
	return NextResponse.json({ error: "Request failed" }, { status: 500 })
}
