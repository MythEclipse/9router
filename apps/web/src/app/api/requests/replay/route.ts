import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * POST /api/requests/replay - export captures as a translator test file.
 *
 * Body: `{ ids?: string[], recent?: number }`. Answers the generated source as a downloadable
 * `.test.ts`, because the destination is `tests/unit/` — the operator saves it and the suite
 * grows a regression case that came from real traffic.
 */
export async function POST(request: Request) {
	try {
		const body = (await request.json().catch(() => ({}))) as { ids?: string[]; recent?: number }
		const client = createApiClient({
			session: sessionClaimsOf(await getSessionContext()),
			useCases: getUseCases(),
			headers: new Headers(),
		})
		const suite = await (await client).requests.export(body)

		return new NextResponse(suite.source, {
			headers: {
				"content-type": "text/typescript; charset=utf-8",
				"content-disposition": `attachment; filename="replay-${suite.cases.length}-cases.test.ts"`,
				"x-replay-cases": String(suite.cases.length),
				"x-replay-skipped": String(suite.skipped),
				"cache-control": "no-store",
			},
		})
	} catch (error) {
		return failed(error, "Failed to export replay cases", "requests/replay")
	}
}
