import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

async function client() {
	return createApiClient({
		session: sessionClaimsOf(await getSessionContext()),
		useCases: getUseCases(),
		headers: new Headers(),
	})
}

// GET /api/keys - List API keys
export async function GET() {
	try {
		const keys = await (await client()).dashboardKeys.list()
		return NextResponse.json({ keys })
	} catch (error) {
		console.log("Error fetching keys:", error)
		return NextResponse.json({ error: "Failed to fetch keys" }, { status: 500 })
	}
}

// POST /api/keys - Create new API key
export async function POST(request: Request) {
	try {
		const body = await request.json().catch(() => ({}))
		const created = await (await client()).dashboardKeys.create(body)
		const { key, secret } = created
		return NextResponse.json(
			{
				// The REST contract names the secret `key`; the procedure returns it as
				// `secret` beside the view. Both doors, one value.
				key: secret,
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
				// Resolved by the router from the same key set it used for the rest of this
				// request, so it cannot disagree with the list the user sees next.
				createdByName: created.createdByName ?? "",
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
function toRefusal(error: unknown) {
	const { code, message } = error as { code?: string; message?: string }
	if (code === "FORBIDDEN") return { status: 403, body: { error: message } }
	if (code === "CONFLICT") return { status: 409, body: { error: message } }
	if (code === "VALIDATION") return { status: 400, body: { error: message } }
	return null
}
