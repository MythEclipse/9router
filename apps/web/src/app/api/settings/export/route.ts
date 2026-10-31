import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { failed } from "@/lib/routeErrors"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

async function client() {
	return createApiClient({
		session: sessionClaimsOf(await getSessionContext()),
		useCases: getUseCases(),
		headers: new Headers(),
	})
}

/**
 * GET /api/settings/export - the routing configuration as a reviewable document.
 *
 * Downloaded rather than rendered: the point is to commit it, diff it, and paste it into an
 * issue. Every credential is already replaced by the domain rule, so the file is safe to send
 * to those places — which is the only reason an export like this may exist at all.
 *
 * `no-store` because a cached copy would be served after the configuration changed, and the
 * diff would then be against a document that no longer describes the install.
 */
export async function GET() {
	try {
		const answer = await (await client()).settings.exportConfig()
		return new NextResponse(answer.body, {
			status: 200,
			headers: {
				"content-type": answer.contentType,
				"content-disposition": `attachment; filename="${answer.filename}"`,
				"cache-control": "no-store",
			},
		})
	} catch (error) {
		return failed(error, "Failed to export the configuration", "settings/export")
	}
}
