import { NextResponse } from "next/server"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"
export const maxDuration = 300

/**
 * "Start" in library mode warms the in-process transform module, auto-installing
 * first only when the operator allowed it. A refusal is a 409, not a 500: nothing
 * failed, the module is simply not installed.
 */
export async function POST() {
	try {
		return NextResponse.json(await getUseCases().pxpipe.start())
	} catch (error) {
		if (isAppError(error, "CONFLICT")) {
			return NextResponse.json({ error: error.message, code: "NOT_INSTALLED" }, { status: 409 })
		}
		console.error("[API] Failed to start pxpipe:", error)
		// The engine names its own failure (NPM_NOT_FOUND, INSTALL_FAILED, …); the
		// panel shows a different hint per code, so it is passed through.
		return NextResponse.json(
			{ error: failureMessage(error, "Failed to start pxpipe"), code: failureCode(error) },
			{ status: 500 },
		)
	}
}

function isAppError(error: unknown, code: string): error is { message: string } {
	return readField(error, "code") === code || readField(error, "appCode") === code
}

function failureCode(error: unknown): string {
	const code = readField(error, "code")
	return typeof code === "string" ? code : "INTERNAL"
}

function failureMessage(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback
}

function readField(error: unknown, field: string): unknown {
	return typeof error === "object" && error !== null && field in error
		? (error as Record<string, unknown>)[field]
		: undefined
}
