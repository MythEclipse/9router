import { NextResponse } from "next/server"
import { crushSettingsConfig, isCrushInstalled, removeCrushSettings } from "@/lib/cliToolHosts"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/** Crush keeps `providers["9router"]` in a shared file; see `crushSettingsConfig`. */
const deps = () => ({
	isInstalled: isCrushInstalled,
	config: crushSettingsConfig,
	sideRemovals: [removeCrushSettings],
	notInstalledMessage: "Crush CLI is not installed",
	appliedMessage: "Crush settings applied successfully!",
	resetMessage: "9Router removed from Crush",
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
		return NextResponse.json({ error: { message: "Invalid JSON body" } }, { status: 400 })
	}
	const answer = await getUseCases().cliTools.writeToolSettings(body, deps())
	return NextResponse.json(answer.body, { status: answer.status })
}

export async function DELETE() {
	const answer = await getUseCases().cliTools.resetToolSettings(deps())
	return NextResponse.json(answer.body, { status: answer.status })
}
