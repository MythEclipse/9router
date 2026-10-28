import { DEFAULT_PERMISSIONS, getSessionContext } from "@9router/auth/dashboardPermissions"
import { creatorNameFor, DASHBOARD_CREATOR, visibleApiKeys } from "@9router/auth/keyCreator"
import { asKeyPermissions } from "9router-api/domain/sub-key-scope"
import { NextResponse } from "next/server"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

// GET /api/keys - List API keys
export async function GET() {
	try {
		const ctx = await getSessionContext()
		const allKeys = [...(await getUseCases().dashboardKeys.list())]
		// One helper answers visibility for every page, so the endpoint list and the
		// per-key usage list show a creator session the same keys. Raw creator keys
		// would hand a session another key's secret, so they never leave this API:
		// the payload carries the creator's name instead.
		const keys = visibleApiKeys(allKeys, ctx.session).map((k) => ({
			...k,
			createdBy: k.createdBy === DASHBOARD_CREATOR ? DASHBOARD_CREATOR : "",
			createdByName: creatorNameFor({ createdBy: k.createdBy, keys: allKeys }),
		}))
		return NextResponse.json({ keys })
	} catch (error) {
		console.log("Error fetching keys:", error)
		return NextResponse.json({ error: "Failed to fetch keys" }, { status: 500 })
	}
}

// POST /api/keys - Create new API key
export async function POST(request) {
	try {
		const ctx = await getSessionContext()

		// The permission gate, the endpoint whitelist, name uniqueness, the creator's
		// caps and the permission clamping all live in the use-case now: this route
		// keeps the request and the reply, so the oRPC router cannot disagree with it.
		const body = await request.json().catch(() => ({}))
		const created = await getUseCases().dashboardKeys.create(body, {
			role: ctx.session?.role ?? null,
			apiKey: ctx.session?.role === "apikey" ? (ctx.session.apiKey ?? null) : null,
			keyName: ctx.session?.keyName ?? null,
			keyId: ctx.session?.keyId ?? null,
			scope: {
				tokenLimit: ctx.session?.tokenLimit ?? null,
				dailyCostLimit: ctx.session?.dailyCostLimit ?? null,
				allowedModels: ctx.session?.allowedModels ?? null,
				allowedEndpoints: Array.isArray(ctx.session?.allowedEndpoints)
					? ctx.session.allowedEndpoints
					: null,
			},
			permissions: asKeyPermissions(ctx.permissions) ?? asKeyPermissions(DEFAULT_PERMISSIONS),
		})

		const { key } = created
		return NextResponse.json(
			{
				key: key.key,
				name: key.name,
				id: key.id,
				machineId: key.machineId,
				isActive: key.isActive,
				tokenLimit: key.tokenLimit,
				usedTokens: key.usedTokens,
				resetInterval: key.resetInterval,
				lastResetAt: key.lastResetAt,
				allowedModels: key.allowedModels,
				allowedEndpoints: key.allowedEndpoints,
				rpmLimit: key.rpmLimit,
				tpmLimit: key.tpmLimit,
				dailyCostLimit: key.dailyCostLimit,
				requestLimit: key.requestLimit,
				limitKind: key.limitKind,
				permissions: key.permissions as Record<string, boolean> | null,
				// The raw creator key is a secret and never leaves the server; the client
				// only ever needs to label who made this one.
				createdBy: "",
				createdByName: creatorNameFor({
					createdBy: key.createdBy,
					keys: [...(await getUseCases().dashboardKeys.list())],
				}),
			},
			{ status: 201 },
		)
	} catch (error) {
		// A rule the use-case refused is the caller's fault, not a server fault, and
		// its message is the one written to be shown. Anything else stays a 500.
		const refused = toRefusal(error)
		if (refused) {
			return NextResponse.json(refused.body, { status: refused.status })
		}
		console.log("Error creating key:", error)
		return NextResponse.json({ error: "Failed to create key" }, { status: 500 })
	}
}

/** Map a typed application error onto the reply the dashboard already expects. */
function toRefusal(error) {
	const code = error?.code
	if (code === "FORBIDDEN") return { status: 403, body: { error: error.message } }
	if (code === "CONFLICT") return { status: 409, body: { error: error.message } }
	if (code === "VALIDATION") return { status: 400, body: { error: error.message } }
	return null
}
