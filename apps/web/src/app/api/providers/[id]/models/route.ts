import { ProviderRefusal } from "9router-api/application/providers/list-provider-models"
import { AppError } from "9router-api/domain/errors"
import { NextResponse } from "next/server"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

const STATUS_OF_APP_ERROR: Record<string, number> = {
	NOT_FOUND: 404,
	VALIDATION: 400,
	UNAUTHORIZED: 401,
	FORBIDDEN: 403,
	CONFLICT: 409,
	UPSTREAM: 502,
	INTERNAL: 500,
}

/**
 * GET /api/providers/[id]/models — ask the provider what models it offers.
 *
 * The status is carried, not invented: a 429 from the provider reaches the
 * dashboard as a 429 so it can say "try again later", and a missing connection is
 * a 404 rather than a failed fetch. A provider that did not answer in time is a
 * 504, which is the only status that says "nothing was wrong with the request".
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params
	try {
		return NextResponse.json(await getUseCases().listProviderModels.run(id))
	} catch (error) {
		if (error instanceof ProviderRefusal) {
			return NextResponse.json({ error: error.message }, { status: error.status })
		}
		if (error instanceof AppError) {
			return NextResponse.json(
				{ error: error.message },
				{ status: STATUS_OF_APP_ERROR[error.code] ?? 500 },
			)
		}
		if (error instanceof Error && error.name === "TimeoutError") {
			return NextResponse.json(
				{ error: "The provider did not answer within 20 seconds" },
				{ status: 504 },
			)
		}
		console.log("Error fetching provider models:", error)
		return NextResponse.json({ error: "Failed to fetch models" }, { status: 500 })
	}
}
