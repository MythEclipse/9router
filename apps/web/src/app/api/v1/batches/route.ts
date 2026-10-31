import { NextResponse } from "next/server"
import { bearerSession } from "@/lib/apiKeyBearer"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * `POST /v1/batches` (create) and `GET /v1/batches` (list).
 *
 * Creation returns immediately, then the job is advanced in the background — `void run(...)`
 * rather than `await`, because a batch that answers only after its first ten requests have
 * finished is a batch that times out at the client. Each tick is capped, so a large file cannot
 * monopolise the process; the job stays `in_progress` and the next call advances it.
 */
async function authorized(request: Request) {
	const session = await bearerSession(request)
	if (!session) {
		return NextResponse.json(
			{ error: { message: "Invalid or inactive API key", type: "invalid_request_error" } },
			{ status: 401 },
		)
	}
	return null
}

/** Calls the gateway's own endpoint, forwarding the caller's credential. */
function dispatcher(request: Request) {
	const origin = new URL(request.url).origin
	const authorization = request.headers.get("authorization") ?? ""

	return async (body: unknown, endpoint: string) => {
		const answer = await fetch(`${origin}${endpoint}`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization },
			body: JSON.stringify(body),
		})
		const text = await answer.text()
		try {
			return { status: answer.status, body: JSON.parse(text) }
		} catch {
			return { status: answer.status, body: { raw: text } }
		}
	}
}

export async function GET(request: Request) {
	const denied = await authorized(request)
	if (denied) return denied

	try {
		return NextResponse.json(await getUseCases().batches.list(), {
			headers: { "cache-control": "no-store" },
		})
	} catch (error) {
		return failed(error, "Failed to list batches", "v1/batches")
	}
}

export async function POST(request: Request) {
	const denied = await authorized(request)
	if (denied) return denied

	try {
		const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
		const useCases = getUseCases()
		const batch = await useCases.batches.create({
			inputFileId: String(body.input_file_id ?? ""),
			endpoint: body.endpoint,
			completionWindow: body.completion_window,
		})

		// One tick now; the job keeps its state so any later call can continue it.
		void useCases.batches.run(batch.id, dispatcher(request)).catch(() => undefined)

		return NextResponse.json(batch)
	} catch (error) {
		return failed(error, "Failed to create the batch", "v1/batches")
	}
}
