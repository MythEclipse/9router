import { NextResponse } from "next/server"
import { deepseekTuiSettingsConfig, isDeepSeekTuiInstalled } from "@/lib/cliToolHosts"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/**
 * DeepSeek TUI owns its whole `config.toml`, so a save replaces the file and a reset restores
 * the tool's own default rather than deleting it — see the host for why.
 */
const deps = () => ({
	isInstalled: isDeepSeekTuiInstalled,
	config: deepseekTuiSettingsConfig,
	notInstalledMessage: "DeepSeek TUI is not installed",
	appliedMessage: "DeepSeek TUI settings applied successfully!",
	resetMessage: "9router config reset to DeepSeek defaults",
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
