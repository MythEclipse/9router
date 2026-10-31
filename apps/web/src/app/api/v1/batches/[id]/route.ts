import { NextResponse } from "next/server"
import { bearerSession } from "@/lib/apiKeyBearer"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * `GET /v1/batches/{id}` (retrieve) and `POST /v1/batches/{id}/cancel`.
 *
 * Retrieval also advances the job by one tick. That is the honest shape for a process with no
 * scheduler: a client polling for its result is the only actor guaranteed to be interested, and
 * a poll that advanced nothing would leave the batch stuck at `in_progress` forever.
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

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
	const denied = await authorized(request)
	if (denied) return denied

	try {
		const { id } = await context.params
		const useCases = getUseCases()
		const batch = await useCases.batches.run(id, dispatcher(request))
		return NextResponse.json(batch, { headers: { "cache-control": "no-store" } })
	} catch (error) {
		return failed(error, "Failed to retrieve the batch", "v1/batches/id")
	}
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
	const denied = await authorized(request)
	if (denied) return denied

	try {
		const { id } = await context.params
		return NextResponse.json(await getUseCases().batches.cancel(id))
	} catch (error) {
		return failed(error, "Failed to cancel the batch", "v1/batches/id")
	}
}
