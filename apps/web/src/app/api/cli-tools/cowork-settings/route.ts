import { getSessionContext } from "@9router/auth/dashboardPermissions"
import { NextResponse } from "next/server"
import { createApiClient, sessionClaimsOf } from "@/lib/orpcClient"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * Claude Desktop (Cowork mode) settings.
 *
 * The rules — which config-library entry is active, why a reset empties the file instead of
 * deleting it, which managed servers count as preset, local or custom — live in
 * `application/cowork-settings`. The paths come from `lib/coworkSettingsHost` because they are
 * platform questions. This file only carries the request across.
 */
async function client(request: Request) {
	return createApiClient({
		session: sessionClaimsOf(await getSessionContext()),
		useCases: getUseCases(),
		headers: request.headers,
	})
}

export async function GET(request: Request) {
	const answer = await (await client(request)).coworkSettings.readSettings()
	return NextResponse.json(answer.body, { status: answer.status })
}

export async function POST(request: Request) {
	let body: unknown
	try {
		body = await request.json()
	} catch {
		return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
	}
	const answer = await (await client(request)).coworkSettings.writeSettings({ body })
	return NextResponse.json(answer.body, { status: answer.status })
}

export async function DELETE(request: Request) {
	const answer = await (await client(request)).coworkSettings.resetSettings()
	return NextResponse.json(answer.body, { status: answer.status })
}
