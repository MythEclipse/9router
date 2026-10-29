import { NextResponse } from "next/server"
import { forgeSettingsConfig, isForgeInstalled, removeForgeSettings } from "@/lib/cliToolHosts"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/** ForgeCode keeps `[openai]` in a TOML file; it shares CodeWhale's implementation. */
const deps = () => ({
	isInstalled: isForgeInstalled,
	config: forgeSettingsConfig,
	sideRemovals: [removeForgeSettings],
	notInstalledMessage: "ForgeCode CLI is not installed",
	appliedMessage: "ForgeCode settings applied successfully!",
	resetMessage: "9Router removed from ForgeCode",
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
