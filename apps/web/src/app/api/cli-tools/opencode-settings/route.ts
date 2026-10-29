import { NextResponse } from "next/server"
import {
	isOpenCodeInstalled,
	openCodeSettingsConfig,
	removeOpenCodeSettings,
} from "@/lib/cliToolHosts"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/** OpenCode keeps a model map, an active pointer and an explorer subagent; see the host. */
const deps = () => ({
	isInstalled: isOpenCodeInstalled,
	config: openCodeSettingsConfig,
	sideRemovals: [removeOpenCodeSettings],
	notInstalledMessage: "OpenCode CLI is not installed",
	appliedMessage: "OpenCode settings applied successfully!",
	resetMessage: "9Router settings removed from OpenCode",
})

export async function GET() {
	const answer = await getUseCases().cliTools.readToolSettingsStatus(deps())
	return NextResponse.json(answer.body, { status: answer.status })
}

export async function POST(request: Request) {
	let body: unknown
	try {
		body = await request.json()
	} catch {
		return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
	}
	const answer = await getUseCases().cliTools.writeToolSettings(body, deps())
	return NextResponse.json(answer.body, { status: answer.status })
}

/** Clears the active model without dropping the models the operator configured. */
export async function PATCH() {
	const answer = await getUseCases().cliTools.clearActiveModel(openCodeSettingsConfig)
	return NextResponse.json(answer.body, { status: answer.status })
}

/**
 * `?model=<id>` removes one model; without it the whole provider goes.
 *
 * Separate from DELETE because they mean different things to the operator: unticking one model
 * is not the same as switching the provider off.
 */
export async function DELETE(request: Request) {
	const modelToRemove = new URL(request.url).searchParams.get("model")
	const answer = modelToRemove
		? await getUseCases().cliTools.removeToolModel(modelToRemove, deps())
		: await getUseCases().cliTools.resetToolSettings(deps())
	return NextResponse.json(answer.body, { status: answer.status })
}
