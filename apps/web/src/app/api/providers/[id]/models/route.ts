/**
 * Ask the provider what models it offers.
 *
 * Delegates: which endpoint answers, how the answer is framed, and what each refusal
 * means are rules and live in `9router-api`.
 *
 * The status is still carried, not invented — a 429 from the provider reaches the
 * dashboard as a 429 so it can say "try again later", and a missing connection is a 404
 * rather than a failed fetch. `ProviderRefusal` extends `AppError` and `toORPCError` lets
 * a carried status win, so `failed()` reproduces the mapping this route used to spell out
 * by hand. The 20-second ceiling stays here because it is about *this* request's patience,
 * not about what a model list is.
 */
import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params
	try {
		const client = createApiClient({
			session: sessionClaimsOf(await getSessionContext()),
			useCases: getUseCases(),
		})
		return NextResponse.json(await client.providers.models({ id }))
	} catch (error) {
		if (error instanceof Error && error.name === "TimeoutError") {
			return NextResponse.json(
				{ error: "The provider did not answer within 20 seconds" },
				{ status: 504 },
			)
		}
		return failed(error, "Failed to fetch models", "Error fetching provider models")
	}
}
