import { NextResponse } from "next/server"
import { bearerSession } from "@/lib/apiKeyBearer"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * `GET /v1/files` and `POST /v1/files` - the OpenAI file API, as far as this gateway needs it.
 *
 * `/api/v1` is a public prefix in `dashboardGuard` (the gateway's own key check is the gate), so
 * this route authenticates itself. `bearerSession` is the same conversion the metrics scrape
 * uses: a key becomes a session with the claims an API-key login produces, so an inactive or
 * expired key is refused by the same rules rather than by a second copy of them.
 *
 * The upload is capped at 8 MB in the domain rule. That is a real limit, not a placeholder:
 * the bytes live in a database row, and a gigabyte upload is an object-storage problem.
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

export async function GET(request: Request) {
	const denied = await authorized(request)
	if (denied) return denied

	try {
		const list = await getUseCases().files.list()
		return NextResponse.json(list, { headers: { "cache-control": "no-store" } })
	} catch (error) {
		return failed(error, "Failed to list files", "v1/files")
	}
}

export async function POST(request: Request) {
	const denied = await authorized(request)
	if (denied) return denied

	try {
		const form = await request.formData()
		const file = form.get("file")
		if (!(file instanceof File)) {
			return NextResponse.json(
				{ error: { message: "A multipart `file` field is required", type: "invalid_request_error" } },
				{ status: 400 },
			)
		}

		const meta = await getUseCases().files.upload({
			filename: file.name,
			purpose: form.get("purpose"),
			contentType: file.type || null,
			bytes: new Uint8Array(await file.arrayBuffer()),
		})

		return NextResponse.json(meta, { status: 200 })
	} catch (error) {
		return failed(error, "Failed to store the file", "v1/files")
	}
}
