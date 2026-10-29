import { NextResponse } from "next/server"
import { isLocalRequest } from "@/dashboardGuard"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

// POST /api/provider-nodes/validate - check a key against a base URL before the
// node is saved. The probe itself lives beside this route (`probe.ts`); the
// use-case owns the order of the checks: shape, then SSRF, then the call.
export async function POST(request) {
	try {
		const body = await request.json()
		const result = await getUseCases().baseUrlValidation.validate({
			baseUrl: body?.baseUrl,
			apiKey: body?.apiKey,
			type: body?.type,
			modelId: body?.modelId,
			local: isLocalRequest(request),
		})
		return NextResponse.json(result)
	} catch (error) {
		return failed(error, "Validation failed", "Error validating provider node")
	}
}
