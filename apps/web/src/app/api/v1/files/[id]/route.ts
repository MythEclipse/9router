import { NextResponse } from "next/server"
import { bearerSession } from "@/lib/apiKeyBearer"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * `GET /v1/files/{id}` (the bytes) and `DELETE /v1/files/{id}`.
 *
 * The id is the key and the filename is decoration, so nothing here builds a path from the name.
 * A missing id answers 404 rather than an empty body: a client that mistyped an id must not
 * mistake silence for a zero-byte file.
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

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
	const denied = await authorized(request)
	if (denied) return denied

	try {
		const { id } = await context.params
		const { meta, bytes } = await getUseCases().files.content(id)

		return new NextResponse(new Uint8Array(bytes), {
			headers: {
				"content-type": meta.contentType || "application/octet-stream",
				"content-length": String(bytes.byteLength),
				"content-disposition": `attachment; filename="${meta.filename}"`,
				"cache-control": "no-store",
			},
		})
	} catch (error) {
		return failed(error, "Failed to read the file", "v1/files/id")
	}
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
	const denied = await authorized(request)
	if (denied) return denied

	try {
		const { id } = await context.params
		return NextResponse.json(await getUseCases().files.remove(id))
	} catch (error) {
		return failed(error, "Failed to delete the file", "v1/files/id")
	}
}
