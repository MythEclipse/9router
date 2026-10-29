import { NextResponse } from "next/server"
import {
	copilotSettingsConfig,
	isCopilotInstalled,
	removeCopilotSettings,
} from "@/lib/cliToolHosts"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/** Copilot keeps an array of vendor entries in VS Code's own settings; see the host. */
const deps = () => ({
	isInstalled: isCopilotInstalled,
	config: copilotSettingsConfig,
	sideRemovals: [removeCopilotSettings],
	notInstalledMessage: "VS Code is not installed",
	appliedMessage: "Copilot settings applied! Reload VS Code to take effect.",
	resetMessage: "9Router removed from GitHub Copilot",
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
