import { NextResponse } from "next/server"
import {
	codewhaleSettingsConfig,
	isCodewhaleInstalled,
	removeCodewhaleSettings,
} from "@/lib/cliToolHosts"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/** CodeWhale keeps `[openai]` in a TOML file; see `codewhaleSettingsConfig`. */
const deps = () => ({
	isInstalled: isCodewhaleInstalled,
	config: codewhaleSettingsConfig,
	sideRemovals: [removeCodewhaleSettings],
	notInstalledMessage: "CodeWhale CLI is not installed",
	appliedMessage: "CodeWhale settings applied successfully!",
	resetMessage: "9Router removed from CodeWhale",
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
