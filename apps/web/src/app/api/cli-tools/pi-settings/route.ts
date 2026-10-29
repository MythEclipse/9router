import { NextResponse } from "next/server"
import { isPiInstalled, piSettingsConfig, removePiSettings } from "@/lib/cliToolHosts"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/** Pi keeps `providers["9router"]` and a model list; see `piSettingsConfig`. */
const deps = () => ({
	isInstalled: isPiInstalled,
	config: piSettingsConfig,
	sideRemovals: [removePiSettings],
	notInstalledMessage: "Pi CLI is not installed",
	appliedMessage: "Pi settings applied! Use /model in Pi to select the 9Router model.",
	resetMessage: "9Router removed from Pi",
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
