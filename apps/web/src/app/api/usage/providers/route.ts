import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { parseAllowedModels } from "@9router/db/repos/allowedModels"
import { providerOptions } from "9router-api/domain/provider-options"
import { NextResponse } from "next/server"
import { getProviderNodes } from "@/lib/localDb"
import { getDistinctProviders } from "@/lib/requestDetailsDb"
import { AI_PROVIDERS, getProviderByAlias } from "@/shared/constants/providers"

export const dynamic = "force-dynamic"

/**
 * GET /api/usage/providers - the providers the filter can offer.
 *
 * An API-key session only sees providers that served one of its allowed models, so the filter
 * cannot be used to discover unrelated providers. That narrowing happens in SQL (the repo takes
 * the patterns); the labelling rule lives in `domain/provider-options.ts`.
 */
export async function GET() {
	try {
		const ctx = await getSessionContext()
		const allowedModelPatterns = parseAllowedModels(ctx.allowedModels || "*")

		// Query the DISTINCT provider column directly: parsing every row's JSON blob (hundreds
		// of MB) is what used to OOM this endpoint.
		const providerIds = await getDistinctProviders(allowedModelPatterns)

		const nodes = {}
		for (const node of await getProviderNodes()) {
			nodes[node.id] = { name: node.name, logo: node.logo }
		}

		const providers = providerOptions(
			providerIds,
			nodes,
			(id) => getProviderByAlias(id) || AI_PROVIDERS[id],
		)

		return NextResponse.json({ providers })
	} catch (error) {
		console.error("[API] Failed to get providers:", error)
		return NextResponse.json({ error: "Failed to fetch providers" }, { status: 500 })
	}
}
