import { NextResponse } from "next/server"
import { droidSettingsConfig, isDroidInstalled, removeDroidSettings } from "@/lib/cliToolHosts"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/** Droid keeps an ordered `customModels` array where position one is the default. */
const deps = () => ({
	isInstalled: isDroidInstalled,
	config: droidSettingsConfig,
	sideRemovals: [removeDroidSettings],
	notInstalledMessage: "Factory Droid CLI is not installed",
	appliedMessage: "Droid settings applied successfully!",
	resetMessage: "9Router settings removed from Droid",
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

export async function DELETE() {
	const answer = await getUseCases().cliTools.resetToolSettings(deps())
	return NextResponse.json(answer.body, { status: answer.status })
}
