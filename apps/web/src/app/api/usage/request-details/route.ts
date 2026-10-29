import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { parseAllowedModels } from "@9router/db/repos/allowedModels"
import { getSettings } from "@9router/db/repos/settingsRepo"
import {
	isPageFailure,
	readRequestDetailsPage,
	redactionSettingsFrom,
	redactRequestDetail,
	shouldIncludePayloads,
} from "9router-api/domain/observability"
import { NextResponse } from "next/server"
import { isAuthenticated } from "@/dashboardGuard"
import { getRequestDetails } from "@/lib/usageDb"

export const dynamic = "force-dynamic"

/**
 * GET /api/usage/request-details
 * Query parameters: page, pageSize (1-100), provider, model, connectionId, status, startDate, endDate
 *
 * Paging and payload redaction are rules, not plumbing: they live in
 * `domain/observability.ts` (they are tested there), and this handler only reads the
 * settings those rules need and shapes the reply.
 */

export async function GET(request: Request) {
	try {
		// An API-key session may only see requests for the models its key allows, so
		// the listing is narrowed before any user-supplied filter is applied.
		const ctx = await getSessionContext()
		const allowedModelPatterns = parseAllowedModels(ctx.allowedModels || "*")
		const { searchParams } = new URL(request.url)

		const paging = readRequestDetailsPage({
			page: searchParams.get("page"),
			pageSize: searchParams.get("pageSize"),
		})
		if (isPageFailure(paging)) {
			return NextResponse.json({ error: paging.error }, { status: paging.status })
		}
		const { page, pageSize } = paging.page
		const provider = searchParams.get("provider")
		const model = searchParams.get("model")
		const connectionId = searchParams.get("connectionId")
		const status = searchParams.get("status")
		const startDate = searchParams.get("startDate")
		const endDate = searchParams.get("endDate")

		const filter: {
			page: number
			pageSize: number
			allowedModelPatterns: string[]
			provider?: string
			model?: string
			connectionId?: string
			status?: string
			startDate?: string
			endDate?: string
		} = {
			page,
			pageSize,
			allowedModelPatterns,
		}

		if (provider) filter.provider = provider
		if (model) filter.model = model
		if (connectionId) filter.connectionId = connectionId
		if (status) filter.status = status
		if (startDate) filter.startDate = startDate
		if (endDate) filter.endDate = endDate

		const result = await getRequestDetails(filter)

		let includePayloads = false
		try {
			const read = redactionSettingsFrom(await getSettings())
			includePayloads = shouldIncludePayloads({
				settings: read.settings,
				requireLoginDisabled: read.requireLoginDisabled,
				// Only consulted when the gateway runs with login off; a throw here is
				// treated as "not authenticated", which is the safe side of the gate.
				requestAuthenticated: read.requireLoginDisabled
					? await isAuthenticated(request).catch(() => false)
					: false,
			}).include
		} catch {
			// Fail closed: an unreadable settings row must not reveal payloads.
			includePayloads = false
		}

		const details = (result.details || []).map((d: Record<string, unknown>) =>
			redactRequestDetail(d, includePayloads),
		)

		return NextResponse.json({
			...result,
			details,
			payloadsIncluded: includePayloads,
		})
	} catch (error) {
		console.error("[API] Failed to get request details:", error)
		return NextResponse.json({ error: "Failed to fetch request details" }, { status: 500 })
	}
}
