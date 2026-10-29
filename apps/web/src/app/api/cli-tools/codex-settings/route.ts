import { NextResponse } from "next/server"
import { codexSettingsConfig, isCodexInstalled, removeCodexSettings } from "@/lib/cliToolHosts"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/** Codex keeps TOML and reads its key from a static header; see `codexSettingsConfig`. */
const deps = () => ({
	isInstalled: isCodexInstalled,
	config: codexSettingsConfig,
	sideRemovals: [removeCodexSettings],
	notInstalledMessage: "Codex CLI is not installed",
	appliedMessage: "Codex settings applied successfully!",
	resetMessage: "9Router settings removed successfully",
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
