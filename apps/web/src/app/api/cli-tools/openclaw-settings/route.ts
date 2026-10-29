import { NextResponse } from "next/server"
import {
	isOpenClawInstalled,
	openclawSettingsConfig,
	removeOpenClawSettings,
	writeOpenClawAgentModels,
} from "@/lib/cliToolHosts"
import { getUseCases } from "@/lib/useCases"

export const dynamic = "force-dynamic"

/** OpenClaw needs a model as well as a URL, and keeps per-agent overrides; see the host. */
const deps = () => ({
	isInstalled: isOpenClawInstalled,
	config: openclawSettingsConfig,
	sideWrites: [writeOpenClawAgentModels],
	sideRemovals: [removeOpenClawSettings],
	notInstalledMessage: "Open Claw CLI is not installed",
	appliedMessage: "Open Claw settings applied successfully!",
	resetMessage: "9Router settings removed from Open Claw",
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
